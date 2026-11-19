FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends libreoffice-writer fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
ENV HOME=/tmp
USER 10001:10001
ENTRYPOINT ["soffice", "-env:UserInstallation=file:///tmp/lo-profile", "--headless"]
CMD ["--version"]
