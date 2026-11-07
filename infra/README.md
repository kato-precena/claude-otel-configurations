# claude-otel インフラ（AWS CDK）

メンバーの端末から Claude Code のログとメトリクスを CloudWatch の OTLP エンドポイントへ直接送るための、AWS 側リソースです。コレクターと ALB は使いません。キーのローテーション手順は [`../docs/key-rotation.md`](../docs/key-rotation.md) にあります。

## 作成されるリソース

- ロググループ `/claude-code/events`（保持期間は既定 365 日、削除保護あり）とログストリーム `default`
- 上記ロググループの Bearer トークン認証（CloudFormation の `BearerTokenAuthenticationEnabled`）
- 系統（ログ、メトリクス）ごとの IAM ユーザーと Secrets Manager シークレット
  - ログ: `claude-otel-logs-writer`、`CloudWatchLogsAPIKeyAccess`、`claude-otel/logs-api-key`
  - メトリクス: `claude-otel-metrics-writer`、`CloudWatchAPIKeyAccess`、`claude-otel/metrics-api-key`
- ローテーション担当者向けのポリシー `ClaudeOtelKeyOperator`（キー発行は 60 日固定の場合だけ許可）
- `IncomingLogEvents` の無受信アラームと SNS トピック
- ダッシュボード `claude-code-usage`（既定の表示期間は直近 7 日。クエリは `lib/claude-otel-stack.ts` の `DASHBOARD_QUERIES` に表で定義）
  - 無受信アラームの状態、イベント種類別件数、時間帯別・利用者別のプロンプト数、利用者別のコストとトークン、モデル別のリクエスト数とコスト、ツール利用状況、API エラー

シークレットの初期値は CDK（Secrets Manager）が生成するランダムな文字列で、実際のキーではありません。テンプレートには `SecretString` を書かないため、スタックを更新しても、手作業で入れたキーは上書きされません。実際のキーは、ローテーション手順に従って手作業で入れます。

## コマンド

```bash
cd infra
npm install
npx tsc --noEmit
npx jest
npx cdk synth -c region=ap-northeast-1
npx cdk deploy -c region=ap-northeast-1
```

デプロイ先のアカウントは、AWS の認証情報から `CDK_DEFAULT_ACCOUNT` として決まります。初めてのアカウントとリージョンでは、先に `npx cdk bootstrap` が必要です。

## コンテキスト

| キー | 必須 | 既定値 | 内容 |
|---|---|---|---|
| `region` | 必須 | なし | デプロイ先のリージョン。未指定だと synth が失敗します |
| `retentionDays` | 任意 | `365` | ロググループの保持日数 |
| `alarmEmail` | 任意 | なし | 指定したときだけ、アラームの通知先に登録します |

例: `npx cdk deploy -c region=ap-northeast-1 -c alarmEmail=ops@example.com`

## 注意事項

- **リージョンでの提供状況を、デプロイ前にコンソールで確認してください。** Bearer トークン認証と OTLP エンドポイントは、リージョンによっては使えない場合があります。このリポジトリでは確認していません。
- **無受信アラームは、4 日続けてイベントが 1 件もないときだけ鳴ります。** 1 日周期で 4 回連続（`evaluationPeriods` 4、`datapointsToAlarm` 4）して下回った場合です。1 日だけで判定すると、誰も使わない土日に毎週鳴ってしまうためです。土日に祝日が重なる連休でも鳴らない長さにしています。
- `alarmEmail` を指定すると、SNS から確認メールが届きます。承認するまで通知は届きません。
- **ダッシュボードのうち、コスト・トークン・モデル・ツール成功率・API エラーのクエリは、実データで確認していません。** 確認済みなのは `attributes.event.name` と `attributes.user.email` のフィールド名までで、`api_request` イベントはまだロググループにありません。数値属性は JSON 文字列で届くため `toNumber()` で変換しています。ウィジェットが空や 0 のときは、実際のイベントの属性名を Logs Insights で確認してください。
- ダッシュボードのウィジェットは CloudWatch Logs Insights を実行するため、表示のたびにスキャン量に応じた課金が発生します。
- ロググループ、ログストリーム、シークレットは `RETAIN` です。スタックを削除しても残るため、作り直すときは手作業で削除してください。
- `iam:CreateServiceSpecificCredential` の条件は、`--credential-age-days 60` を付けた場合だけ許可します。付け忘れると拒否されます。
