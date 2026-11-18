# フェーズ0 PoC 実機確認手順(0-4 / 0-5)

IC 読み出し(`packages/zairyu-ic`)を実機の NFC でつなぎ、サーバーで署名検証する。

## 準備

- Node 22、pnpm 10
- Android: Android Studio と NFC(Type B)対応の実機、USB デバッグ
- iOS: Xcode が入った Mac、iPhone 7 以降、Apple Developer Program のチーム
  - App ID で **NFC Tag Reading** を有効にする(エンタイトルメントと select-identifiers は `app.json` から自動生成)
- サンプルカード(入管庁から貸与)または実カード
- 端末と PC を同じ LAN に置く

## 手順

```bash
pnpm install
pnpm build

# API(PC 上)
cd apps/api
ZAIRYU_ENABLE_POC=1 pnpm dev            # :3000 で待ち受け

# アプリ(別ターミナル)
cd apps/mobile
cp .env.example .env                    # EXPO_PUBLIC_API_URL を PC の LAN IP に書き換える
pnpm android                            # または pnpm ios(Development Build を作って実機にインストール)
```

`app.json` の `ios.bundleIdentifier` / `android.package` は仮の値(`com.example.zairyu`)。iOS は自分のチームで使える ID に変えること。

## 確認すること

アプリで在留カード番号を入力し「ICを読み取る」を押してカードをかざす。

| 項目 | 期待する結果 |
| --- | --- |
| 様式 | 旧様式 / 第2世代 / 特定在留カードが正しく表示される |
| 署名 | 「署名OK(発行者未確認)」。発行者証明書を入手するまでは未確認のままで正しい |
| IC内の番号 | 第2世代・特定は「券面と一致」 |
| 券面記載事項・裏面 | 実カードの記載と一致する |
| 番号を 1 文字変えた場合 | 旧様式・第2世代は「カードとの認証に失敗」、特定は「番号が一致しません」 |
| 読取時間 | 計測履歴に記録される(TASKS 0-4/0-5 の完了条件) |

## 計測記録

| 日付 | 端末 / OS | 様式 | 読取時間(ms) | APDU 数 | 署名 | 備考 |
| --- | --- | --- | --- | --- | --- | --- |
| | | | | | | |

## 実機で確かめる不明点(SPEC_NOTES.md 3〜4章)

- 特定在留カード: 配送鍵の入手後に `EXPO_PUBLIC_TOKUTEI_DELIVERY_KEY_N/_E` を設定して試す。SM カウンタ N の進め方、EF 選択(EF03 か EF04 か)、分割読出しの上限(既定 0x400)
- iOS: 拡張長 APDU(旧様式の券面イメージは応答が約 7KB)が通るか。通らなければ `maxReadLength` を設定して分割読出しに切り替える
- Android: `getMaxTransceiveLength` が小さい端末では自動で分割読出しになる

## 失敗したとき

- 画面に出る `step`(get_challenge / mutual_authenticate / verify / select / read)と SW を記録する
- 金属の机の上では読めないことがある。カードを手に持ち、端末の NFC アンテナ位置(Android は機種ごとに異なる、iPhone は上部)に当てる
- **ログやスクリーンショットにカード番号・氏名を残さないこと**
