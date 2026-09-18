# CountdownApp

A lightweight self-hosted countdown clock designed for CasaOS.

## CasaOS deployment

The application follows the same deployment pattern as Circuit:

1. GitHub Actions builds the application image from the repository.
2. The image is published to GitHub Container Registry as:
   `ghcr.io/srfarsquatch/countdownapp:edge`
3. CasaOS pulls the finished image directly from GHCR.
4. No source files, Git checkout, Dockerfile, or local build are required on the CasaOS server.

### Install

Download `docker-compose.casaos.yml` from this repository.

In CasaOS:

1. Open **App Store**.
2. Choose **Custom Install**.
3. Select the **Docker Compose** import/upload option.
4. Upload `docker-compose.casaos.yml`.
5. Install the application.
6. Open `http://<casaos-server-ip>:8088`.

The Compose file uses `pull_policy: always`, so saving/updating the CasaOS application will pull the newest published `edge` image.

## Updating

Push changes to `main`. The **Publish Countdown container** GitHub Action builds and publishes a fresh container image.

After the workflow succeeds, update/recreate the existing Countdown app in CasaOS to pull the latest image.

## Registry access

The container is published through GitHub Container Registry. If CasaOS reports `unauthorized` when pulling the image, either make the `countdownapp` package public in GitHub Packages or authenticate the CasaOS Docker host to `ghcr.io` with a token that has `read:packages` access.

## Port

The web interface is exposed on host port **8088**.
