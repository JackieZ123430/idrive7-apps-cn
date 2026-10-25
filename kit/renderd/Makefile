# Built inside the Ubuntu 18.04 image (docker/Dockerfile): glibc 2.27 like the MGU.
#   docker run --rm -v $PWD:/src mgu-renderd-build make
PROTO = protocol/ivi-controller protocol/ivi-application
GEN = $(foreach p,$(PROTO),$(p)-client-protocol.h $(p)-protocol.c)
CFLAGS ?= -O2 -g0 -Wall -Wno-unused-parameter -Wno-misleading-indentation -Iprotocol -Isrc
LDFLAGS += -Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2
LIBS = -lwayland-client -lwayland-egl -lEGL -lGLESv2 -lm
all: build/ivi-probe build/mgu-renderd build/mgu-inputgate.so
protocol/%-client-protocol.h: protocol/%.xml ; wayland-scanner client-header $< $@
protocol/%-protocol.c: protocol/%.xml ; wayland-scanner private-code $< $@ 2>/dev/null || wayland-scanner code $< $@
build/ivi-probe: tools/ivi-probe.c $(GEN) | build
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ tools/ivi-probe.c protocol/ivi-controller-protocol.c protocol/ivi-application-protocol.c $(LIBS)
build/mgu-renderd: $(wildcard src/*.c src/*.h) $(GEN) | build
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $(wildcard src/*.c) protocol/ivi-controller-protocol.c protocol/ivi-application-protocol.c $(LIBS)
# loaded into the HMI (LD_PRELOAD): the controller gate for full-screen apps (inputgate/)
build/mgu-inputgate.so: inputgate/mgu-inputgate.cpp | build
	$(CXX) -std=c++14 -O2 -g0 -Wall -shared -fPIC -Iinputgate/vsomeip-include/interface/compat -o $@ $< -ldl
build: ; mkdir -p build
clean: ; rm -rf build protocol/*-protocol.c protocol/*-client-protocol.h
.PHONY: all clean
