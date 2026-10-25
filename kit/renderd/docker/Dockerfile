# Build image for mgu-renderd: Ubuntu 18.04 has glibc 2.27, the same as the MGU,
# so binaries built here run on the head unit unchanged.
FROM ubuntu:18.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      gcc g++ make libc6-dev libwayland-dev libegl1-mesa-dev libgles2-mesa-dev pkg-config file \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
