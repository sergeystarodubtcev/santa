#!/usr/bin/env bash
# Деплой в Yandex Cloud: бакет (сайт + база), облачная функция (API), API Gateway (адрес сайта).
# Запускается из GitHub Actions. Нужны переменные: YC_SA_KEY (авторизованный ключ сервисного аккаунта, JSON),
# ADMIN_PASSWORD (необязательно).
set -euo pipefail

if ! command -v yc >/dev/null; then
  curl -sSL https://storage.yandexcloud.net/yandexcloud-yc/install.sh | bash -s -- -i "$HOME/yc" -n
  export PATH="$HOME/yc/bin:$PATH"
fi

KEY_FILE="$(mktemp)"
trap 'rm -f "$KEY_FILE"' EXIT
# Ключ часто вставляют в секрет не целиком (без первой/последней фигурной скобки, с лишними пробелами).
# Чиним мелкие обрывы и проверяем, что это авторизованный ключ, не печатая его содержимое.
printf '%s' "$YC_SA_KEY" | node -e '
  let s = require("fs").readFileSync(0, "utf8").replace(/^\uFEFF/, "").trim();
  if (!s.startsWith("{")) s = "{" + s;
  if (!s.endsWith("}")) s = s.replace(/,\s*$/, "") + "}";
  let k;
  try { k = JSON.parse(s); } catch (e) {
    console.error("::error::Секрет YC_SA_KEY — не JSON. Откройте authorized_key.json блокнотом и вставьте в секрет всё содержимое целиком, от { до }.");
    process.exit(1);
  }
  const need = ["id", "service_account_id", "private_key"].filter((x) => !k[x]);
  if (need.length) {
    console.error("::error::В секрете YC_SA_KEY нет полей: " + need.join(", ") + ". Нужен файл авторизованного ключа (authorized_key.json), а не API-ключ или статический ключ.");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(k));
' > "$KEY_FILE"
yc config profile create santa-ci >/dev/null 2>&1 || yc config profile activate santa-ci >/dev/null
yc config set service-account-key "$KEY_FILE"

SA_ID="$(jq -r .service_account_id "$KEY_FILE")"
FOLDER_ID="$(yc iam service-account get --id "$SA_ID" --format json | jq -r .folder_id)"
yc config set folder-id "$FOLDER_ID"
BUCKET="kofesanta-${FOLDER_ID}"
echo "Каталог: $FOLDER_ID, сервисный аккаунт: $SA_ID, бакет: $BUCKET"

# 1. Бакет (приватный)
if ! yc storage bucket get "$BUCKET" >/dev/null 2>&1; then
  yc storage bucket create --name "$BUCKET" --default-storage-class standard --max-size 1073741824 >/dev/null
  echo "Создан бакет $BUCKET"
fi

# 2. Статика сайта -> s3://BUCKET/site/
TOKEN="$(yc iam create-token)"
SITE="$(mktemp -d)"
cp -r public/. "$SITE/"
echo "window.SANTA_CONFIG = { apiUrl: '' };" > "$SITE/js/config.js"
ctype() {
  case "$1" in
    *.html) echo 'text/html; charset=utf-8' ;; *.css) echo 'text/css; charset=utf-8' ;;
    *.js) echo 'text/javascript; charset=utf-8' ;; *.json) echo 'application/json' ;;
    *.png) echo 'image/png' ;; *.jpg|*.jpeg) echo 'image/jpeg' ;; *.svg) echo 'image/svg+xml' ;;
    *.webp) echo 'image/webp' ;; *.ico) echo 'image/x-icon' ;; *) echo 'application/octet-stream' ;;
  esac
}
n=0
while IFS= read -r -d '' f; do
  rel="${f#"$SITE"/}"
  curl -fsS -X PUT "https://storage.yandexcloud.net/$BUCKET/site/$rel" \
    -H "X-YaCloud-SubjectToken: $TOKEN" -H "Content-Type: $(ctype "$rel")" \
    -H "Cache-Control: no-cache" --data-binary "@$f" >/dev/null
  n=$((n + 1))
done < <(find "$SITE" -type f -print0)
echo "Загружено файлов сайта: $n"

# 3. Облачная функция
FN_DIR="$(mktemp -d)"
cp cloud/index.js "$FN_DIR/index.js"
cp public/js/core.js "$FN_DIR/core.js"
echo '{"name":"kofesanta-api","private":true}' > "$FN_DIR/package.json"
yc serverless function get --name santa-api >/dev/null 2>&1 || yc serverless function create --name santa-api >/dev/null
ENV_ARGS=(--environment "BUCKET=$BUCKET")
if [ -n "${ADMIN_PASSWORD:-}" ]; then ENV_ARGS+=(--environment "ADMIN_PASSWORD=$ADMIN_PASSWORD"); fi
deploy_fn() {
  yc serverless function version create --function-name santa-api --runtime "$1" --entrypoint index.handler \
    --memory 256m --execution-timeout 15s --source-path "$FN_DIR" --service-account-id "$SA_ID" "${ENV_ARGS[@]}" >/dev/null
}
deploy_fn nodejs22 || { echo "nodejs22 недоступен, пробую nodejs18"; deploy_fn nodejs18; }
FN_ID="$(yc serverless function get --name santa-api --format json | jq -r .id)"
echo "Функция: $FN_ID"

# 4. API Gateway
SPEC="$(mktemp)"
sed -e "s/__BUCKET__/$BUCKET/g" -e "s/__SA__/$SA_ID/g" -e "s/__FN__/$FN_ID/g" cloud/gateway.yaml > "$SPEC"
if yc serverless api-gateway get --name kofesanta >/dev/null 2>&1; then
  yc serverless api-gateway update --name kofesanta --spec "$SPEC" >/dev/null
else
  yc serverless api-gateway create --name kofesanta --spec "$SPEC" >/dev/null
fi
DOMAIN="$(yc serverless api-gateway get --name kofesanta --format json | jq -r .domain)"
URL="https://$DOMAIN"

# 5. Проверка
sleep 5
echo "Проверка $URL/api/health"
HEALTH="$(curl -fsS "$URL/api/health" || true)"
echo "$HEALTH"
curl -fsS -o /dev/null "$URL/" && echo "Главная открывается"
{
  echo "## ☕ Тайный Санта развёрнут в Yandex Cloud"
  echo ""
  echo "**Сайт:** $URL"
  echo ""
  echo "**Админка:** $URL/admin.html"
  echo ""
  echo "Проверка API: \`$HEALTH\`"
} >> "${GITHUB_STEP_SUMMARY:-/dev/stdout}"
