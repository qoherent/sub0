FROM node:24-bookworm

ARG ZIG_VERSION=0.16.0
ADD https://ziglang.org/download/${ZIG_VERSION}/zig-x86_64-linux-${ZIG_VERSION}.tar.xz /tmp/zig.tar.xz
RUN tar -xf /tmp/zig.tar.xz -C /opt && rm /tmp/zig.tar.xz
ENV PATH="/opt/zig-x86_64-linux-${ZIG_VERSION}:${PATH}"
RUN zig version

WORKDIR /fx
COPY fx /fx
RUN zig build -Doptimize=Debug; ls -la zig-out/bin/

WORKDIR /work
CMD ["bash"]
