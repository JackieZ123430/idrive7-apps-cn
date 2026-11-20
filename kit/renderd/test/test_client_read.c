/*
 * An app's input (main.c client_read): an app that sends faster than the renderer reads does not grow the buffer past
 * one whole message (MAX_MSG) however long it keeps sending, nor hold the renderer in one read for longer than about
 * that much (poll wakes it again for the rest), a message of MAX_MSG still arrives whole, and memory that runs out
 * drops the app instead of crashing. main.c is built into this test with recv and realloc replaced:
 * recv hands out a scripted stream in pieces, as a busy socket does, and says EAGAIN only at its end.
 *   build/host/test_client_read
 */
#define _GNU_SOURCE
#include <errno.h>
#include <stdlib.h>
#include <sys/socket.h>

static ssize_t feed_recv(int fd, void *buf, size_t n, int flags);
static void *feed_realloc(void *p, size_t n);
#define recv feed_recv
#define realloc feed_realloc
#define main renderd_main
#include "../src/main.c"
#undef main
#undef realloc
#undef recv

static int fails;
#define CHECK(cond, what) do { if (cond) printf("ok   %s\n", what); else { printf("FAIL %s\n", what); fails++; } } while (0)

/* the stream: small messages repeated up to `flood` bytes, or the bytes of `msg` */
static const uint8_t *msg;
static size_t msg_len, flood, pos, piece;
static uint8_t small[16];
static client *watched;
static size_t peak, realloc_max;

static ssize_t feed_recv(int fd, void *buf, size_t n, int flags)
{
    (void)fd, (void)flags;
    if (watched && watched->incap > peak) peak = watched->incap;
    size_t total = msg ? msg_len : flood, k = total - pos;
    if (!k) { errno = EAGAIN; return -1; }
    if (k > n) k = n;
    if (k > piece) k = piece;
    for (size_t i = 0; i < k; i++) ((uint8_t *)buf)[i] = msg ? msg[pos + i] : small[(pos + i) % sizeof small];
    pos += k;
    return (ssize_t)k;
}

static void *feed_realloc(void *p, size_t n)
{
    if (realloc_max && n > realloc_max) return NULL;
    return realloc(p, n);
}

static client *new_client(void)
{
    client *c = calloc(1, sizeof *c);
    c->fd = -1; c->xf.s = 1; c->mode = MODE_LAYER; c->uid = 1000; c->g.name = c->app;
    strcpy(c->app, "test");
    watched = c; peak = 0; pos = 0;
    return c;
}

static void put(uint8_t *at, uint32_t type, uint32_t len) { memcpy(at, &type, 4); memcpy(at + 4, &len, 4); }

int main(void)
{
    setvbuf(stdout, NULL, _IONBF, 0);                   /* each line out before a crash */
    /* an unknown message (ignored), 16 bytes, sent without a pause: 128 MiB */
    put(small, 0x7e000001u, 8);
    client *c = new_client();
    flood = 128u << 20; piece = 1u << 20; msg = NULL;
    int r = client_read(c), wakeups = 1;
    size_t first = pos;
    CHECK(r == 0 && first < flood && first <= MAX_IN + piece, "one wakeup reads at most about MAX_MSG of it");
    while (r == 0 && pos < flood) { r = client_read(c); wakeups++; }
    CHECK(r == 0 && pos == flood && c->inlen == 0, "a 128 MiB stream of small messages is read whole");
    printf("     (%d wakeups, the first read %zu KiB)\n", wakeups, first >> 10);
    CHECK(peak <= MAX_MSG + (1u << 20), "its buffer stays within one message of MAX_MSG");
    printf("     (the buffer grew to %zu KiB)\n", peak >> 10);

    /* a small FRAME, then one of MAX_MSG, in pieces of odd sizes */
    size_t big = MAX_MSG;
    msg_len = 8 + 16 + 8 + big;
    uint8_t *m = malloc(msg_len);
    put(m, M_FRAME, 16); memset(m + 8, 0, 16);
    put(m + 24, M_FRAME, (uint32_t)big);
    for (size_t i = 0; i < big; i++) m[32 + i] = (uint8_t)(i * 7 + 3);
    msg = m;
    c = new_client();
    piece = 100003;
    r = client_read(c);
    CHECK(r == 0 && c->inlen == 0, "a FRAME of MAX_MSG after a small one is read whole");
    CHECK(c->frame_words == big / 4 && !memcmp(c->frame, m + 32, big), "it arrives intact");
    CHECK(peak <= MAX_MSG + (1u << 20), "the buffer holds no more than that message");

    /* memory runs out while a large message comes: the app is dropped, nothing crashes */
    c = new_client();
    realloc_max = 1u << 20;
    piece = 65536;
    r = client_read(c);
    CHECK(r < 0, "no memory for a large message: the app is dropped");

    /* ...also when the read buffer cannot grow for the rest of a message that fits the first one */
    msg_len = 8 + 250000;
    put(m, M_FRAME, 250000);
    c = new_client();
    realloc_max = 300000;
    piece = 50000;
    r = client_read(c);
    CHECK(r < 0, "no memory to read on: the app is dropped");

    if (fails) { printf("test_client_read: %d failed\n", fails); return 1; }
    puts("test_client_read: all passed");
    return 0;
}
