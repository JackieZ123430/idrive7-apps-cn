# kit/renderd: the renderer (mgu-render from robertnisipeanu/mgu-store, built here as mgu-renderd), the controller
# gate and ivi-probe. See README.md.
#
#   docker run --rm -v $PWD:/src mgu-renderd-build make   head-unit binaries in build/ (Ubuntu 18.04, glibc 2.27, like
#                                                          the unit; kit/tools/make_kit.py runs this)
#   make check-target    the renderer's loader, libraries and glibc versions (inside the same image)
#   make test            protocol, touch-routing, community-socket, video, page-template-script and embed-buffer unit
#                        tests, and recorded sessions of both legacy kits replayed through the original daemons and
#                        this one, frames compared (Docker, Ubuntu 24.04 with Mesa)
#   make check-protocol IVI_LIB_DIR=<dir>   protocol/*.xml against the unit's libivi-*.so

DOCKER  ?= docker
CFLAGS  ?= -O2 -g0 -Wall -Wextra -Wno-unused-parameter -Wno-misleading-indentation -Werror
CFLAGS  += -std=gnu11 -Isrc -Ibuild/$(OUT)/protocol
LIBS     = -lwayland-client -lwayland-egl -lEGL -lGLESv2 -lm -ldl
SRC      = $(wildcard src/*.c)
HDR      = $(wildcard src/*.h)
XML      = protocol/ivi-application.xml protocol/ivi-controller.xml protocol/wayland-drm.xml
GEN_DIR  = build/$(OUT)/protocol
GEN_H    = $(XML:protocol/%.xml=$(GEN_DIR)/%-client-protocol.h)
GEN_C    = $(XML:protocol/%.xml=$(GEN_DIR)/%-protocol.c)
TEST_IMAGE = mgu-render-test
RUN = $(DOCKER) run --rm -v "$(CURDIR):/w" -w /w -u $$(id -u):$$(id -g)
UNIT_LD = -Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2

.PHONY: all check-target check-protocol test in-test clean
all: build/mgu-renderd build/mgu-inputgate.so build/ivi-probe

$(GEN_DIR)/%-client-protocol.h: protocol/%.xml
	@mkdir -p $(GEN_DIR)
	wayland-scanner client-header $< $@
$(GEN_DIR)/%-protocol.c: protocol/%.xml
	@mkdir -p $(GEN_DIR)
	wayland-scanner private-code $< $@ 2>/dev/null || wayland-scanner code $< $@

# the head unit's renderer (OUT empty: protocol code in build/protocol)
build/mgu-renderd: $(SRC) $(HDR) $(GEN_H) $(GEN_C)
	$(CC) $(CFLAGS) $(UNIT_LD) -o $@ $(SRC) $(GEN_C) $(LIBS)
	strip $@
# loaded into the HMI (LD_PRELOAD): the controller gate for full-screen apps (inputgate/)
build/mgu-inputgate.so: inputgate/mgu-inputgate.cpp
	@mkdir -p build
	$(CXX) -std=c++14 -O2 -g0 -Wall -shared -fPIC -Iinputgate/vsomeip-include/interface/compat -o $@ $< -ldl
build/ivi-probe: tools/ivi-probe.c $(GEN_H) $(GEN_C)
	$(CC) -O2 -g0 -Wall -Wno-unused-parameter -I$(GEN_DIR) $(UNIT_LD) -o $@ tools/ivi-probe.c \
		$(GEN_DIR)/ivi-controller-protocol.c $(GEN_DIR)/ivi-application-protocol.c -lwayland-client -lwayland-egl -lEGL -lGLESv2 -lm

check-target: build/mgu-renderd
	sh tools/check_target.sh build/mgu-renderd

check-protocol:
	@test -n "$(IVI_LIB_DIR)" || { echo "set IVI_LIB_DIR to a directory with libivi-application.so.1.11.0 and libivi-controller.so.1.11.0"; exit 2; }
	python3 tools/check_protocol_abi.py --lib $(IVI_LIB_DIR)/libivi-application.so.1.11.0 --xml protocol/ivi-application.xml
	python3 tools/check_protocol_abi.py --lib $(IVI_LIB_DIR)/libivi-controller.so.1.11.0 --xml protocol/ivi-controller.xml

test:
	$(DOCKER) build -q -t $(TEST_IMAGE) docker/test >/dev/null
	$(RUN) $(TEST_IMAGE) make -s in-test OUT=host

build/$(OUT)/mgu-render: $(SRC) $(HDR) $(GEN_H) $(GEN_C)
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $(SRC) $(GEN_C) $(LIBS)
	strip $@

in-test: build/$(OUT)/mgu-render
	$(CC) $(CFLAGS) -o build/$(OUT)/test_dialect test/test_dialect.c src/dialect.c
	build/$(OUT)/test_dialect
	$(CC) $(CFLAGS) -o build/$(OUT)/test_dbr test/test_dbr.c src/dbr.c
	build/$(OUT)/test_dbr
	$(CC) $(CFLAGS) -o build/$(OUT)/test_touch test/test_touch.c
	build/$(OUT)/test_touch
	$(CC) $(CFLAGS) -o build/$(OUT)/test_share test/test_share.c src/log.c
	build/$(OUT)/test_share
	$(CC) $(CFLAGS) -o build/$(OUT)/test_video test/test_video.c src/gfx.c src/log.c -lEGL -lGLESv2 -lm
	LIBGL_ALWAYS_SOFTWARE=1 EGL_PLATFORM=surfaceless build/$(OUT)/test_video
	sh test/test_hmi.sh
	for x in ivi-application wayland-drm; do wayland-scanner server-header protocol/$$x.xml $(GEN_DIR)/$$x-server-protocol.h; done
	$(CC) $(CFLAGS) -o build/$(OUT)/mock_hmi test/mock_hmi.c $(GEN_DIR)/ivi-application-protocol.c $(GEN_DIR)/wayland-drm-protocol.c -lwayland-server
	$(CC) $(CFLAGS) -DMGU_FAKE_DMABUF -o build/$(OUT)/test_embed test/test_embed.c src/embed.c src/embed_gl.c src/gfx.c src/log.c \
		$(GEN_DIR)/ivi-application-protocol.c $(GEN_DIR)/wayland-drm-protocol.c -lwayland-client -lEGL -lGLESv2 -lm -ldl
	LIBGL_ALWAYS_SOFTWARE=1 EGL_PLATFORM=surfaceless build/$(OUT)/test_embed build/$(OUT)/mock_hmi
	# the recorded sessions need the original daemons' sources (test/reference/), which this tree does not carry
	if [ -d test/reference/upstream ]; then sh test/replay.sh build/$(OUT); else echo "replay: no test/reference here, skipped"; fi

clean:
	rm -rf build
