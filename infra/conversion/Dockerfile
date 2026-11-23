FROM python:3.11.18-slim-bookworm@sha256:a83ba18aef0f865b1a4a611c2cf460fe446f2795673bbb9fe43be570439e3b39
RUN apt-get update \
    && apt-get install -y --no-install-recommends libreoffice-writer fonts-liberation poppler-utils \
    && rm -rf /var/lib/apt/lists/*
COPY server.py /opt/conversion/server.py
RUN chmod 0755 /opt/conversion && chmod 0555 /opt/conversion/server.py
ENV HOME=/tmp PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
USER 10001:10001
ENTRYPOINT ["soffice", "-env:UserInstallation=file:///tmp/lo-profile", "--headless"]
CMD ["--version"]
