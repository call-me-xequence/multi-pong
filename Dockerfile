# Dockerfile для Bothost — https://bothost.ru/docs/custom-dockerfile
# Должен лежать в КОРНЕ репозитория: Bothost собирает образ из корня.
#
# Отличия от backend/Dockerfile (тот остаётся для docker-compose):
#  * пути с префиксом backend/ — контекст сборки здесь корень репозитория;
#  * бинарник кладётся в /usr/local/bin, а статика — в /srv/www, потому что
#    на Bothost каталог /app монтируется исходниками из Git и всё, что
#    скопировано в /app, будет скрыто этим mount'ом;
#  * отдельного nginx нет: один контейнер и один порт, поэтому Go сам
#    раздаёт собранный фронтенд через STATIC_DIR.

# ---- Build stage ----
FROM golang:1.22-alpine AS build
WORKDIR /src

COPY backend/go.mod backend/go.sum ./
RUN go mod download

COPY backend/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/neonpong .

# ---- Runtime stage ----
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata

# Бинарник — ВНЕ /app (иначе его скроет bind-mount исходников).
COPY --from=build /out/neonpong /usr/local/bin/neonpong

# Статика фронтенда — тоже вне /app.
COPY frontend/index.html /srv/www/index.html
COPY frontend/css /srv/www/css
COPY frontend/dist /srv/www/dist
COPY frontend/audio /srv/www/audio

# Bothost прокидывает PORT и ждёт прослушивание 0.0.0.0:<PORT>.
ENV PORT=8080 \
    STATIC_DIR=/srv/www
EXPOSE 8080

CMD ["/usr/local/bin/neonpong"]
