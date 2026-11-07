import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { ClaudeOtelStack, DASHBOARD_NAME, DASHBOARD_QUERIES, SIGNALS, Signal } from '../lib/claude-otel-stack';

const synth = (alarmEmail?: string) =>
  Template.fromStack(
    new ClaudeOtelStack(new App(), 'Test', {
      env: { account: '123456789012', region: 'ap-northeast-1' },
      retentionDays: RetentionDays.ONE_YEAR,
      alarmEmail,
    }),
  );

const signals = Object.entries(SIGNALS) as [Signal, (typeof SIGNALS)[Signal]][];

describe('ClaudeOtelStack', () => {
  const template = synth();

  test('log group enables bearer token auth and is retained', () => {
    template.hasResource('AWS::Logs::LogGroup', {
      Properties: {
        LogGroupName: '/claude-code/events',
        RetentionInDays: 365,
        BearerTokenAuthenticationEnabled: true,
      },
      DeletionPolicy: 'Retain',
    });
    template.hasResourceProperties('AWS::Logs::LogStream', { LogStreamName: 'default' });
  });

  test.each(signals)('%s user has its managed policy and no access keys', (_signal, spec) => {
    template.hasResourceProperties('AWS::IAM::User', {
      UserName: spec.iamUserName,
      ManagedPolicyArns: [
        { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, `:iam::aws:policy/${spec.managedPolicyName}`]] },
      ],
    });
    expect(Object.keys(template.findResources('AWS::IAM::AccessKey'))).toHaveLength(0);
  });

  test.each(signals)('%s secret is retained', (_signal, spec) => {
    template.hasResource('AWS::SecretsManager::Secret', {
      Properties: { Name: spec.secretName },
      DeletionPolicy: 'Retain',
    });
  });

  test.each(signals)('operator policy limits %s key creation to 60 days', (_signal, spec) => {
    template.hasResourceProperties('AWS::IAM::ManagedPolicy', {
      ManagedPolicyName: 'ClaudeOtelKeyOperator',
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'iam:CreateServiceSpecificCredential',
            Condition: {
              StringEquals: { 'iam:ServiceSpecificCredentialServiceName': spec.credentialServiceName },
              NumericEquals: { 'iam:ServiceSpecificCredentialAgeDays': '60' },
            },
          }),
        ]),
      },
    });
  });

  test('operator policy manages credentials and secret values', () => {
    template.hasResourceProperties('AWS::IAM::ManagedPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: [
              'iam:ListServiceSpecificCredentials',
              'iam:UpdateServiceSpecificCredential',
              'iam:DeleteServiceSpecificCredential',
              'iam:ResetServiceSpecificCredential',
            ],
          }),
          Match.objectLike({ Action: ['secretsmanager:PutSecretValue', 'secretsmanager:GetSecretValue'] }),
        ]),
      },
    });
  });

  test('secrets carry no SecretString so updates never overwrite a hand-set key', () => {
    const secrets = Object.values(template.findResources('AWS::SecretsManager::Secret'));
    expect(secrets).toHaveLength(2);
    for (const secret of secrets) {
      expect(secret.Properties).not.toHaveProperty('SecretString');
    }
  });

  test('alarm fires after 4 straight days without events, including missing data', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/Logs',
      MetricName: 'IncomingLogEvents',
      Dimensions: [{ Name: 'LogGroupName', Value: '/claude-code/events' }],
      Statistic: 'Sum',
      Period: 86400,
      EvaluationPeriods: 4,
      DatapointsToAlarm: 4,
      Threshold: 1,
      ComparisonOperator: 'LessThanThreshold',
      TreatMissingData: 'breaching',
      AlarmActions: [{ Ref: Match.stringLikeRegexp('AlarmTopic') }],
    });
  });

  test('email subscription exists only when alarmEmail is given', () => {
    expect(Object.keys(template.findResources('AWS::SNS::Subscription'))).toHaveLength(0);
    synth('ops@example.com').hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'ops@example.com',
    });
  });

  test('dashboard has every widget, queries the log group and defaults to 7 days', () => {
    template.hasResourceProperties('AWS::CloudWatch::Dashboard', { DashboardName: DASHBOARD_NAME });
    expect(DASHBOARD_NAME).toBe('claude-code-usage');
    const resources = Object.values(template.findResources('AWS::CloudWatch::Dashboard'));
    expect(resources).toHaveLength(1);
    const body = JSON.stringify(resources[0].Properties.DashboardBody);
    for (const { title } of DASHBOARD_QUERIES) {
      expect(body).toContain(title);
    }
    expect(body).toContain("SOURCE '/claude-code/events'");
    expect(body).toContain('-P7D');
    expect(body).toContain('NoIncomingLogEventsAlarm');
  });

  test('outputs', () => {
    for (const name of ['LogGroupName', 'LogsSecretName', 'MetricsSecretName', 'OperatorPolicyArn', 'AlarmTopicArn']) {
      expect(template.toJSON().Outputs).toHaveProperty(name);
    }
  });
});
