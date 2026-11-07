# CloudWatch API キー ローテーション手順（手動）

Claude Code のテレメトリを CloudWatch に直接送るための API キー（Bearer トークン）を、手作業で差し替える手順です。

## ルール

- キーの有効期限は **60 日固定**です。
- **30 日ごと**（直前のキーが切れる 30 日前）に新しいキーを発行し、server-managed settings に反映します。
- 常に新旧 2 本のキーが有効な状態になり、重複期間は 30 日です。
- キーは **ログ用** と **メトリクス用** の 2 系統あります。毎回両方を差し替えます。

```
キー1: Day 0  ─────────── Day 60
キー2:        Day 30 ─────────── Day 90
キー3:               Day 60 ─────────── Day 120
       ↑ 30日ごとに発行して server-managed settings に反映する
```

## 対象

| 系統 | IAM ユーザー | `--service-name` | Secrets Manager のシークレット |
|---|---|---|---|
| ログ | `claude-otel-logs-writer` | `logs.amazonaws.com` | `claude-otel/logs-api-key` |
| メトリクス | `claude-otel-metrics-writer` | `cloudwatch.amazonaws.com` | `claude-otel/metrics-api-key` |

## 注意事項

- **キーを画面や会話に出さないでください。** 発行したキーは Secrets Manager に直接保存し、ターミナルへは表示させません。Slack、メール、AI チャットに貼ったキーは漏洩したものとして扱い、すぐに無効化して再発行します。
- **IAM の制限で、1 系統あたり同時に 2 本までしかキーを持てません。** 期限が切れたキーを削除してから、新しいキーを発行します。

---

## 毎月の作業（30 日ごと）

以下は系統ごとに実行します。`USER`、`SERVICE`、`SECRET` は上の表の値に置き換えてください。

```bash
export AWS_REGION=<region>
USER=claude-otel-logs-writer      # メトリクスの場合は claude-otel-metrics-writer
SERVICE=logs.amazonaws.com        # メトリクスの場合は cloudwatch.amazonaws.com
SECRET=claude-otel/logs-api-key   # メトリクスの場合は claude-otel/metrics-api-key
```

### 1. 現在のキーを確認する

```bash
aws iam list-service-specific-credentials \
  --user-name "$USER" --service-name "$SERVICE" \
  --query 'ServiceSpecificCredentials[].[ServiceSpecificCredentialId,Status,CreateDate,ExpirationDate]' \
  --output table
```

### 2. 期限が切れたキーを削除する

作成から 60 日が過ぎたキーを削除します。

```bash
aws iam delete-service-specific-credential \
  --user-name "$USER" \
  --service-specific-credential-id <期限切れのID>
```

### 3. 新しいキーを発行し、Secrets Manager に保存する

キーはターミナルに表示させず、そのまま Secrets Manager に保存します。

```bash
aws secretsmanager put-secret-value \
  --secret-id "$SECRET" \
  --secret-string "$(aws iam create-service-specific-credential \
      --user-name "$USER" --service-name "$SERVICE" \
      --credential-age-days 60 \
      --query 'ServiceSpecificCredential.ServiceCredentialSecret' --output text)"
```

### 4. server-managed settings に反映する

1. AWS コンソールの Secrets Manager で、新しいキーの値を確認します。
2. claude.ai の管理コンソールで server-managed settings を開き、`env` の該当箇所を書き換えます。
   - ログ用のキーは `OTEL_EXPORTER_OTLP_LOGS_HEADERS` の `Authorization=Bearer ...` に入れます。
   - メトリクス用のキーは `OTEL_EXPORTER_OTLP_METRICS_HEADERS` の `Authorization=Bearer ...` に入れます。
3. 設定の全体像は [`client/server-managed-settings.example.json`](../client/server-managed-settings.example.json) を参照してください。

### 5. 動作を確認する

1. 自分の端末で Claude Code を再起動し、簡単な操作をします。
2. ログは、ロググループ `/claude-code/events` に新しいイベントが届いていることを確認します。
3. メトリクスは、CloudWatch の Query Studio で `claude_code` のメトリクスが更新されていることを確認します。
4. 手順 1 のコマンドを再度実行し、有効なキーが 2 本あることを確認します。

### 6. 作業記録を残す

下の作業記録に 1 行追加します。

---

## 漏洩が疑われるとき

1. 該当するキーをすぐに無効化します。

   ```bash
   aws iam update-service-specific-credential \
     --user-name "$USER" \
     --service-specific-credential-id <ID> --status Inactive
   ```

2. CloudTrail のデータイベントで、不審な利用がないか調べます。ログは `AWS::Logs::LogGroupAuthorization`、メトリクスは `AWS::CloudWatch::Dataset` です。
3. 毎月の作業の手順 2〜5 に沿って、代わりのキーを発行し、反映します。
4. 無効化したキーを削除します。

---

## 作業記録

| 日付 | 系統 | 削除したキーID | 新しいキーID | 担当 |
|---|---|---|---|---|
| | | | | |
