# ---- Build stage ----
FROM golang:1.22-alpine AS build
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/neonpong .

# ---- Runtime stage ----
FROM alpine:3.19
RUN apk add --no-cache ca-certificates tzdata
WORKDIR /app
COPY --from=build /out/neonpong /app/neonpong

ENV PORT=8080
EXPOSE 8080

ENTRYPOINT ["/app/neonpong"]
