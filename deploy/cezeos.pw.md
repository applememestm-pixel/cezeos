# Публикация cezeos.pw

## DNS и канонический адрес

На DNS-серверах домена укажите A-записи `@` и `www` с адресом VPS. Если у VPS нет настроенного IPv6, для этих имён не должно быть устаревших записей AAAA. Дождитесь, когда оба имени разрешаются в адрес VPS. Основной адрес приложения — `https://cezeos.pw`; `https://www.cezeos.pw` перенаправляется на него с сохранением пути и параметров. [Настройка A-записей в REG.RU](https://help.reg.ru/support/dns-servery-i-nastroyka-zony/rabota-s-dns-serverami/kak-privyazat-domen-k-ip-adresu)

## VPS со свободными портами 80 и 443

Скопируйте пример окружения один раз. Основная база, ключ Региона и сертификаты находятся в постоянных томах. Файл `.env` хранится только на VPS.

```sh
git clone https://github.com/applememestm-pixel/cezeos.git
cd cezeos
install -m 600 deploy/cezeos.pw.env.example .env
docker compose -p cezeos up -d --build --wait
```

Caddy выпускает и обновляет сертификаты автоматически. Разрешите входящие TCP 80 и 443 на VPS и в панели провайдера. Порт приложения 4173 опубликован только на loopback. [Автоматический HTTPS Caddy](https://caddyserver.com/docs/automatic-https)

## VPS с существующим прокси

Сохраните существующие сайты на их прокси. Для Caddy отключите профиль `https` в `.env`, запустите сервис `region` и добавьте содержимое `Caddyfile.cezeos` в конфигурацию существующего Caddy. При запуске вне Compose прокси использует `127.0.0.1:4173`. Если 4173 уже занят, задайте свободный `CEZEOS_HOST_PORT` и направьте прокси на него. На другом HTTPS-прокси передайте исходный заголовок `Host` и настройте редирект `www` на основной домен. [Reverse proxy Caddy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)

## Проверка и регистрация

```sh
curl --fail --show-error https://cezeos.pw/healthz
curl --fail --show-error https://cezeos.pw/.well-known/cezeos-region.json
curl --head --show-error https://www.cezeos.pw/
```

Ожидаются `status: ok`, `origin: https://cezeos.pw` и перенаправление на основной домен. Чтобы включить вход через Telegram, зарегистрируйте `https://cezeos.pw/api/auth/telegram/callback` в BotFather, добавьте Client ID и Client Secret в `.env` на VPS и повторно выполните `docker compose -p cezeos up -d --wait`. До подключения провайдера публичная лента открывается гостям, деморегистрация выключена. [Telegram Login](https://core.telegram.org/bots/telegram-login)
