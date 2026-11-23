-- 写真の撮り直し: 撮影した表面・裏面の画像を差し替えるとき、古い画像の行を消す(不要な個人データを持ち続けない)。
-- 消せるのは自テナントの行だけ(RLS の tenant_isolation)。アプリは撮影画像(front / back)だけを消す
GRANT DELETE ON card_images TO zairyu_app;
