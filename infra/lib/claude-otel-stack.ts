import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
} from 'aws-cdk-lib';
import {
  Alarm,
  AlarmStatusWidget,
  ComparisonOperator,
  Dashboard,
  LogQueryVisualizationType,
  LogQueryWidget,
  Metric,
  TreatMissingData,
} from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { Effect, ManagedPolicy, PolicyStatement, User } from 'aws-cdk-lib/aws-iam';
import { CfnLogGroup, LogGroup, LogStream, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

export type Signal = 'logs' | 'metrics';

interface SignalSpec {
  iamUserName: string;
  credentialServiceName: string;
  managedPolicyName: string;
  secretName: string;
}

// Names are shared with docs/key-rotation.md.
export const SIGNALS: Record<Signal, SignalSpec> = {
  logs: {
    iamUserName: 'claude-otel-logs-writer',
    credentialServiceName: 'logs.amazonaws.com',
    managedPolicyName: 'CloudWatchLogsAPIKeyAccess',
    secretName: 'claude-otel/logs-api-key',
  },
  metrics: {
    iamUserName: 'claude-otel-metrics-writer',
    credentialServiceName: 'cloudwatch.amazonaws.com',
    managedPolicyName: 'CloudWatchAPIKeyAccess',
    secretName: 'claude-otel/metrics-api-key',
  },
};

export const LOG_GROUP_NAME = '/claude-code/events';
export const LOG_STREAM_NAME = 'default';
export const OPERATOR_POLICY_NAME = 'ClaudeOtelKeyOperator';
export const KEY_LIFETIME_DAYS = 60;

export const DASHBOARD_NAME = 'claude-code-usage';

interface DashboardQuery {
  title: string;
  query: string;
  view: 'table' | 'bar' | 'line';
  width: number;
}

const EVENT = 'attributes.event.name';
const USER = 'attributes.user.email';
const NOISE_FILTER = `filter ${EVENT} not in ["plugin_loaded", "managed_settings_resolved"] and ${EVENT} not like /^hook_/`;

// Numeric attributes arrive as JSON strings, so sums go through toNumber().
export const DASHBOARD_QUERIES: DashboardQuery[] = [
  {
    title: 'イベント種類別件数',
    query: `${NOISE_FILTER} | stats count(*) as events by ${EVENT} | sort events desc`,
    view: 'table',
    width: 12,
  },
  {
    title: '時間帯別プロンプト数',
    query: `filter ${EVENT} = "user_prompt" | stats count(*) as prompts by bin(1h)`,
    view: 'line',
    width: 12,
  },
  {
    title: '利用者別プロンプト数',
    query: `filter ${EVENT} = "user_prompt" | stats count(*) as prompts by ${USER} | sort prompts desc`,
    view: 'bar',
    width: 12,
  },
  {
    title: '利用者別コストとトークン',
    query: `filter ${EVENT} = "api_request" | stats count(*) as requests, sum(toNumber(attributes.cost_usd)) as cost_usd, sum(toNumber(attributes.input_tokens)) as input_tokens, sum(toNumber(attributes.output_tokens)) as output_tokens by ${USER} | sort cost_usd desc`,
    view: 'table',
    width: 12,
  },
  {
    title: 'モデル別リクエスト数とコスト',
    query: `filter ${EVENT} = "api_request" | stats count(*) as requests, sum(toNumber(attributes.cost_usd)) as cost_usd by attributes.model | sort requests desc`,
    view: 'table',
    width: 12,
  },
  {
    title: 'ツール利用状況',
    query: `filter ${EVENT} = "tool_result" | stats count(*) as calls, sum(strcontains(attributes.success, "true")) as succeeded, sum(strcontains(attributes.success, "true")) * 100 / count(*) as success_rate_pct by attributes.tool_name | sort calls desc`,
    view: 'table',
    width: 12,
  },
  {
    title: 'API エラー',
    query: `filter ${EVENT} = "api_error" | stats count(*) as errors by attributes.status_code, attributes.error | sort errors desc`,
    view: 'table',
    width: 24,
  },
];

const VIEWS: Record<DashboardQuery['view'], LogQueryVisualizationType> = {
  table: LogQueryVisualizationType.TABLE,
  bar: LogQueryVisualizationType.BAR,
  line: LogQueryVisualizationType.LINE,
};

export interface ClaudeOtelStackProps extends StackProps {
  retentionDays: RetentionDays;
  alarmEmail?: string;
}

export class ClaudeOtelStack extends Stack {
  constructor(scope: Construct, id: string, props: ClaudeOtelStackProps) {
    super(scope, id, props);

    const logGroup = new LogGroup(this, 'EventsLogGroup', {
      logGroupName: LOG_GROUP_NAME,
      retention: props.retentionDays,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // CloudFormation supports this natively (AWS::Logs::LogGroup BearerTokenAuthenticationEnabled),
    // but the L2 LogGroup does not expose it yet.
    (logGroup.node.defaultChild as CfnLogGroup).bearerTokenAuthenticationEnabled = true;

    new LogStream(this, 'DefaultLogStream', {
      logGroup,
      logStreamName: LOG_STREAM_NAME,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const operatorStatements: PolicyStatement[] = [];
    const secretArns: string[] = [];
    const secretNames: Record<Signal, string> = { logs: '', metrics: '' };

    for (const [signal, spec] of Object.entries(SIGNALS) as [Signal, SignalSpec][]) {
      const user = new User(this, `${signal}Writer`, {
        userName: spec.iamUserName,
        managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName(spec.managedPolicyName)],
      });

      const secret = new Secret(this, `${signal}ApiKeySecret`, {
        secretName: spec.secretName,
        description: `CloudWatch ${signal} API key (bearer token). Value is set by hand during rotation.`,
        removalPolicy: RemovalPolicy.RETAIN,
      });
      secretArns.push(secret.secretArn);
      secretNames[signal] = spec.secretName;

      operatorStatements.push(
        new PolicyStatement({
          sid: `Create${signal}Key`,
          effect: Effect.ALLOW,
          actions: ['iam:CreateServiceSpecificCredential'],
          resources: [user.userArn],
          conditions: {
            StringEquals: { 'iam:ServiceSpecificCredentialServiceName': spec.credentialServiceName },
            NumericEquals: { 'iam:ServiceSpecificCredentialAgeDays': String(KEY_LIFETIME_DAYS) },
          },
        }),
        new PolicyStatement({
          sid: `Manage${signal}Key`,
          effect: Effect.ALLOW,
          actions: [
            'iam:ListServiceSpecificCredentials',
            'iam:UpdateServiceSpecificCredential',
            'iam:DeleteServiceSpecificCredential',
            'iam:ResetServiceSpecificCredential',
          ],
          resources: [user.userArn],
        }),
      );
    }

    operatorStatements.push(
      new PolicyStatement({
        sid: 'StoreKeys',
        effect: Effect.ALLOW,
        actions: ['secretsmanager:PutSecretValue', 'secretsmanager:GetSecretValue'],
        resources: secretArns,
      }),
    );

    const operatorPolicy = new ManagedPolicy(this, 'KeyOperatorPolicy', {
      managedPolicyName: OPERATOR_POLICY_NAME,
      description: 'Lets people rotate the Claude Code OTLP API keys.',
      statements: operatorStatements,
    });

    const topic = new Topic(this, 'AlarmTopic', { displayName: 'Claude OTel alarms' });
    if (props.alarmEmail) {
      topic.addSubscription(new EmailSubscription(props.alarmEmail));
    }

    const alarm = new Alarm(this, 'NoIncomingLogEventsAlarm', {
      alarmDescription:
        'No Claude Code events reached the log group for 4 consecutive days (covers a weekend plus a holiday).',
      metric: new Metric({
        namespace: 'AWS/Logs',
        metricName: 'IncomingLogEvents',
        dimensionsMap: { LogGroupName: LOG_GROUP_NAME },
        statistic: 'Sum',
        period: Duration.days(1),
      }),
      threshold: 1,
      comparisonOperator: ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 4,
      datapointsToAlarm: 4,
      treatMissingData: TreatMissingData.BREACHING,
    });
    alarm.addAlarmAction(new SnsAction(topic));

    const dashboard = new Dashboard(this, 'UsageDashboard', {
      dashboardName: DASHBOARD_NAME,
      start: '-P7D',
    });
    dashboard.addWidgets(new AlarmStatusWidget({ title: '無受信アラーム', alarms: [alarm], width: 24, height: 2 }));
    dashboard.addWidgets(
      ...DASHBOARD_QUERIES.map(
        (q) =>
          new LogQueryWidget({
            title: q.title,
            logGroupNames: [LOG_GROUP_NAME],
            queryString: q.query,
            view: VIEWS[q.view],
            width: q.width,
            height: 6,
          }),
      ),
    );

    new CfnOutput(this, 'LogGroupName', { value: logGroup.logGroupName });
    new CfnOutput(this, 'LogsSecretName', { value: secretNames.logs });
    new CfnOutput(this, 'MetricsSecretName', { value: secretNames.metrics });
    new CfnOutput(this, 'OperatorPolicyArn', { value: operatorPolicy.managedPolicyArn });
    new CfnOutput(this, 'AlarmTopicArn', { value: topic.topicArn });
  }
}
