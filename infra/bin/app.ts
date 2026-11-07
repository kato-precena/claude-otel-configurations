import { App } from 'aws-cdk-lib';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { ClaudeOtelStack } from '../lib/claude-otel-stack';

const app = new App();

const region = app.node.tryGetContext('region');
if (typeof region !== 'string' || region === '') {
  throw new Error('context "region" is required. Example: cdk synth -c region=ap-northeast-1');
}

const retentionDays = Number(app.node.tryGetContext('retentionDays') ?? 365);
if (!(Object.values(RetentionDays) as unknown[]).includes(retentionDays)) {
  throw new Error(`context "retentionDays" must be a value CloudWatch Logs supports, got: ${retentionDays}`);
}

const alarmEmail = app.node.tryGetContext('alarmEmail');

new ClaudeOtelStack(app, 'ClaudeOtelStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region },
  retentionDays: retentionDays as RetentionDays,
  alarmEmail: typeof alarmEmail === 'string' && alarmEmail !== '' ? alarmEmail : undefined,
});
