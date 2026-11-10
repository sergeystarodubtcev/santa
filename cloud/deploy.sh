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
# Сразу после привязки платёжного аккаунта Object Storage несколько минут может отвечать
# «cloud does not exist» — ждём и пробуем снова.
for i in 1 2 3 4 5 6 7 8 9 10; do
  if yc storage bucket get "$BUCKET" >/dev/null 2>&1; then break; fi
  if yc storage bucket create --name "$BUCKET" --default-storage-class standard --max-size 1073741824 >/dev/null; then
    echo "Создан бакет $BUCKET"; break
  fi
  if [ "$i" = 10 ]; then echo "::error::Не удалось создать бакет. Проверьте, что платёжный аккаунт активен и привязан к облаку."; exit 1; fi
  echo "Хранилище ещё не готово, жду 60 с (попытка $i/10)…"; sleep 60
done

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
  curl -fsS --retry 5 --retry-all-errors --connect-timeout 20 -X PUT "https://storage.yandexcloud.net/$BUCKET/site/$rel" \
    -H "X-YaCloud-SubjectToken: $TOKEN" -H "Content-Type: $(ctype "$rel")" \
    -H "Cache-Control: no-cache" --data-binary "@$f" >/dev/null
  n=$((n + 1))
done < <(find "$SITE" -type f -print0)
echo "Загружено файлов сайта: $n"

# 3. Облачная функция
FN_DIR="$(mktemp -d)"
cp cloud/index.js "$FN_DIR/index.js"
cp cloud/bot.js "$FN_DIR/bot.js"
cp public/js/core.js "$FN_DIR/core.js"
echo '{"name":"kofesanta-api","private":true}' > "$FN_DIR/package.json"
yc serverless function get --name santa-api >/dev/null 2>&1 || yc serverless function create --name santa-api >/dev/null
ENV_ARGS=(--environment "BUCKET=$BUCKET")
if [ -n "${ADMIN_PASSWORD:-}" ]; then ENV_ARGS+=(--environment "ADMIN_PASSWORD=$ADMIN_PASSWORD"); fi

# Адрес сайта для ссылок из бота: свой домен, если сертификат уже выпущен, иначе адрес шлюза.
GW_DOMAIN="$(yc serverless api-gateway get --name kofesanta --format json 2>/dev/null | jq -r '.domain // empty' || true)"
SITE_URL="${GW_DOMAIN:+https://$GW_DOMAIN}"
if [ -n "${CUSTOM_DOMAIN:-}" ] && [ "$(yc certificate-manager certificate get --name "cert-$(echo "$CUSTOM_DOMAIN" | tr '.' '-')" --format json 2>/dev/null | jq -r '.status // empty')" = "ISSUED" ]; then
  SITE_URL="https://$CUSTOM_DOMAIN"
fi
ENV_ARGS+=(--environment "SITE_URL=$SITE_URL")

# Telegram-бот (необязательно): токен из секрета TG_BOT_TOKEN
TG_USERNAME=""
# TG_MODE: off — бот выключен (из Yandex Cloud нет связи с Telegram), polling | webhook — бот работает прямо из функции
if [ "${TG_MODE:-off}" != "polling" ]; then
  if yc serverless trigger get --name santa-bot-poll >/dev/null 2>&1; then
    yc serverless trigger delete --name santa-bot-poll >/dev/null && echo "Таймер опроса бота удалён (TG_MODE=off)"
  fi
fi
if [ -n "${TG_BOT_TOKEN:-}" ] && [ "${TG_MODE:-off}" != "off" ]; then
  TG_USERNAME="$(curl -fsS "https://api.telegram.org/bot$TG_BOT_TOKEN/getMe" | jq -r '.result.username // empty' || true)"
  if [ -z "$TG_USERNAME" ]; then echo "::error::Telegram не принял TG_BOT_TOKEN (getMe). Проверьте токен от @BotFather."; exit 1; fi
  echo "Бот: @$TG_USERNAME (режим $TG_MODE)"
  if [ "$TG_MODE" = "relay" ]; then
    # токен остаётся в GitHub; облаку — только имя бота и общий секрет с ретранслятором
    ENV_ARGS+=(--environment "TG_BOT_USERNAME=$TG_USERNAME" --environment "TG_RELAY_SECRET=$(printf '%s' "$TG_BOT_TOKEN" | sha256sum | cut -c1-32)")
  else
    ENV_ARGS+=(--environment "TG_BOT_TOKEN=$TG_BOT_TOKEN" --environment "TG_BOT_USERNAME=$TG_USERNAME")
  fi
fi
deploy_fn() {
  yc serverless function version create --function-name santa-api --runtime "$1" --entrypoint index.handler \
    --memory 256m --execution-timeout 60s --source-path "$FN_DIR" --service-account-id "$SA_ID" "${ENV_ARGS[@]}" >/dev/null
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

# 4b. Свой домен (например santa.speccof.ru): сертификат Let's Encrypt через Certificate Manager.
DNS_NOTE=""
if [ -n "${CUSTOM_DOMAIN:-}" ]; then
  CERT_NAME="cert-$(echo "$CUSTOM_DOMAIN" | tr '.' '-')"
  if ! yc certificate-manager certificate get --name "$CERT_NAME" >/dev/null 2>&1; then
    yc certificate-manager certificate request --name "$CERT_NAME" --domains "$CUSTOM_DOMAIN" --challenge dns >/dev/null
    echo "Заказан сертификат для $CUSTOM_DOMAIN"
    sleep 10
  fi
  CERT_JSON="$(yc certificate-manager certificate get --name "$CERT_NAME" --full --format json)"
  CERT_ID="$(echo "$CERT_JSON" | jq -r .id)"
  CERT_STATUS="$(echo "$CERT_JSON" | jq -r .status)"
  echo "Сертификат $CERT_ID: $CERT_STATUS"
  if [ "$CERT_STATUS" != "ISSUED" ] && [ -n "${DNS_ZONE:-}" ]; then
    command -v dig >/dev/null || sudo apt-get install -y -qq dnsutils >/dev/null 2>&1 || true
    echo "NS в реестре .RU:   $(dig +short NS "$DNS_ZONE" @a.dns.ripn.net 2>/dev/null | tr '\n' ' ')"
    echo "NS у Google DNS:    $(dig +short NS "$DNS_ZONE" @8.8.8.8 2>/dev/null | tr '\n' ' ')"
    echo "Запись проверки:    $(dig +short CNAME "_acme-challenge.$CUSTOM_DOMAIN" @8.8.8.8 2>/dev/null)"
  fi
  echo "$CERT_JSON" | jq -r '.challenges[]? | "Проверка домена: \(.status) — \(.dns_challenge.type // "") \(.dns_challenge.name // "") → \(.dns_challenge.value // "")"'
  # Если DNS домена делегирован в Yandex Cloud DNS (DNS_ZONE), записи создаём сами.
  if [ -n "${DNS_ZONE:-}" ]; then
    ZONE_NAME="zone-$(echo "$DNS_ZONE" | tr '.' '-')"
    if ! yc dns zone get --name "$ZONE_NAME" >/dev/null 2>&1; then
      yc dns zone create --name "$ZONE_NAME" --zone "$DNS_ZONE." --public-visibility >/dev/null
      echo "Создана DNS-зона $DNS_ZONE"
    fi
    CH_NAME="$(echo "$CERT_JSON" | jq -r '[.challenges[]? | select(.dns_challenge.type == "CNAME")][0].dns_challenge.name // empty')"
    CH_VALUE="$(echo "$CERT_JSON" | jq -r '[.challenges[]? | select(.dns_challenge.type == "CNAME")][0].dns_challenge.value // empty')"
    if [ -n "$CH_NAME" ]; then
      yc dns zone replace-records --name "$ZONE_NAME" --record "$CH_NAME 600 CNAME $CH_VALUE" >/dev/null
    fi
    yc dns zone replace-records --name "$ZONE_NAME" --record "$CUSTOM_DOMAIN. 600 CNAME $DOMAIN." >/dev/null
    echo "DNS-записи в зоне $DNS_ZONE обновлены:"
    yc dns zone list-records --name "$ZONE_NAME" --format json | jq -r '.. | objects | select(has("type") and has("name")) | "  \(.name) \(.type) \(.data | tostring)"' || true
  fi
  if [ "$CERT_STATUS" = "ISSUED" ]; then
    if yc serverless api-gateway get --name kofesanta --format json | jq -e --arg d "$CUSTOM_DOMAIN" '[.attached_domains[]?.domain] | index($d)' >/dev/null; then
      echo "Домен $CUSTOM_DOMAIN уже привязан к шлюзу"
    else
      yc serverless api-gateway add-domain --name kofesanta --domain "$CUSTOM_DOMAIN" --certificate-id "$CERT_ID" >/dev/null
      echo "Домен $CUSTOM_DOMAIN привязан к шлюзу"
    fi
    URL="https://$CUSTOM_DOMAIN"
  else
    DNS_NOTE="$(echo "$CERT_JSON" | jq -r '.challenges[]? | "- `\(.dns_challenge.type)` **\(.dns_challenge.name)** → `\(.dns_challenge.value)`"')"
  fi
fi

# 4c. Telegram: вебхук, меню команд и ежедневный таймер напоминаний (12:00 МСК)
if [ -n "$TG_USERNAME" ]; then
  HOOK_SECRET="$(printf '%s' "$TG_BOT_TOKEN" | sha256sum | cut -c1-32)"
  if [ "$TG_MODE" = "relay" ]; then
    echo "Бот работает через ретранслятор в GitHub Actions (workflow «Telegram-бот»)"
  elif [ "$TG_MODE" = "webhook" ]; then
    curl -fsS "https://api.telegram.org/bot$TG_BOT_TOKEN/setWebhook" \
      --data-urlencode "url=https://$DOMAIN/api/tg/webhook" -d "secret_token=$HOOK_SECRET" \
      --data-urlencode 'allowed_updates=["message","callback_query"]' | jq -c '{ok, description}'
  else
    # Режим опроса: вебхук выключаем (накопившиеся сообщения не теряются), функция забирает их сама раз в минуту
    curl -fsS "https://api.telegram.org/bot$TG_BOT_TOKEN/deleteWebhook" | jq -c '{ok, description}'
    if ! yc serverless trigger get --name santa-bot-poll >/dev/null 2>&1; then
      yc serverless trigger create timer --name santa-bot-poll --cron-expression '* * ? * * *' --payload poll \
        --invoke-function-id "$FN_ID" --invoke-function-service-account-id "$SA_ID" >/dev/null
      echo "Создан таймер опроса бота (раз в минуту)"
    fi
  fi
  if ! yc serverless trigger get --name santa-reminders >/dev/null 2>&1; then
    yc serverless trigger create timer --name santa-reminders --cron-expression '0 9 ? * * *' \
      --invoke-function-id "$FN_ID" --invoke-function-service-account-id "$SA_ID" >/dev/null
    echo "Создан таймер напоминаний (каждый день в 12:00 МСК)"
  fi
fi

# 4d. Видит ли облачная функция Telegram
if [ -n "$TG_USERNAME" ] && [ "$TG_MODE" != "relay" ] && [ -n "${ADMIN_PASSWORD:-}" ]; then
  ADM="$(curl -fsS -X POST "https://$DOMAIN/api/admin/login" -H 'Content-Type: application/json' \
    -d "$(jq -n --arg p "$ADMIN_PASSWORD" '{password:$p}')" | jq -r '.token // empty' || true)"
  if [ -n "$ADM" ]; then
    echo "Связь функции с Telegram: $(curl -fsS -m 40 "https://$DOMAIN/api/admin/tg-check" -H "Authorization: Bearer $ADM" | jq -c '{reachable, ms, bot, error, node, ipv4, url: .webhook.url, pending: .webhook.pending_update_count}' || echo 'не удалось проверить')"
  fi
fi

# 5. Проверка
sleep 5
if [ "$TG_MODE" = "relay" ] && [ -n "$TG_USERNAME" ]; then
  RELAY_CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "https://$DOMAIN/api/tg/outbox" -H "X-Relay-Secret: $(printf '%s' "$TG_BOT_TOKEN" | sha256sum | cut -c1-32)" -H 'Content-Type: application/json' -d '{}')"
  BAD_CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "https://$DOMAIN/api/tg/outbox" -H 'X-Relay-Secret: wrong' -d '{}')"
  echo "Ретранслятор: с секретом → $RELAY_CODE, с чужим секретом → $BAD_CODE"
  echo "Слежение за адвентом (проверка из облака): $(curl -s -m 30 -X POST "https://$DOMAIN/api/tg/watch" -H "X-Relay-Secret: $(printf '%s' "$TG_BOT_TOKEN" | sha256sum | cut -c1-32)" -H 'Content-Type: application/json' -d '{"key":"tastycoffee-advent-2027"}' | jq -c '{status, done, error, admins, sent: (.out|length)}')"
  [ "$RELAY_CODE" = 200 ] && [ "$BAD_CODE" = 403 ] || { echo "::error::Эндпоинт ретранслятора отвечает не так, как ожидалось"; exit 1; }
fi
echo "Проверка $URL/api/health"
HEALTH="$(curl -fsS "$URL/api/health" || true)"
echo "$HEALTH"
check() { # метод путь ожидаемый_код [тело]
  local code
  if [ "$1" = POST ]; then code="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d "${4:-{\}}" "$URL$2")"
  else code="$(curl -s -o /dev/null -w '%{http_code}' "$URL$2")"; fi
  if [ "$code" = "$3" ]; then echo "✓ $1 $2 → $code"; else echo "::error::✗ $1 $2 → $code (ожидали $3)"; FAILED=1; fi
}
FAILED=0
check GET / 200
check GET /cabinet.html 200
check GET /admin.html 200
check GET /privacy.html 200
check GET /css/style.css 200
check GET /js/core.js 200
check GET /img/logo.png 200
check GET /api/public 200
check POST /api/login 401 '{"login":"nobody","password":"x"}'
check POST /api/register 400 '{"name":"x"}'
check GET /api/me 401
for p in / /css/style.css /js/core.js /img/logo.png; do
  ct="$(curl -s -o /dev/null -w '%{content_type}' "$URL$p")"
  echo "Тип $p: $ct"
  case "$p:$ct" in
    /:text/html*|*.css:text/css*|*.js:text/javascript*|*.png:image/png*) ;;
    *) echo "::warning::Неожиданный Content-Type у $p: $ct" ;;
  esac
done
[ "$FAILED" = 0 ] || exit 1
{
  if [ -n "${DNS_ZONE:-}" ] && [ -n "$DNS_NOTE" ]; then
    echo "## 🌐 DNS домена $DNS_ZONE ведётся в Yandex Cloud"
    echo "Записи созданы автоматически. В панели регистратора укажите NS: \`ns1.yandexcloud.net\` и \`ns2.yandexcloud.net\`."
    echo ""
    DNS_NOTE=""
  fi
  if [ -n "$DNS_NOTE" ]; then
    echo "## 🌐 Чтобы заработал $CUSTOM_DOMAIN, добавьте DNS-записи"
    echo "$DNS_NOTE"
    echo "- \`CNAME\` **$CUSTOM_DOMAIN** → \`$DOMAIN\`"
    echo ""
  fi
  echo "## ☕ Тайный Санта развёрнут в Yandex Cloud"
  echo ""
  echo "**Сайт:** $URL"
  echo ""
  echo "**Админка:** $URL/admin.html"
  echo ""
  echo "Проверка API: \`$HEALTH\`"
} >> "${GITHUB_STEP_SUMMARY:-/dev/stdout}"
