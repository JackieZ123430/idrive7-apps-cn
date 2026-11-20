/*
 * The foreground gate's start and stop (gate.c) when a pipe or the fork fails: no descriptor is left open, and
 * gate_stop() then signals and waits for nothing (a pid of -1 would be every process). Built with --wrap for pipe2,
 * fork, kill and waitpid (Makefile); kill and waitpid pass only real children on.
 *   build/host/test_gate
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>
#include "gate.h"

static int fails;
#define CHECK(cond, what) do { if (cond) printf("ok   %s\n", what); else { printf("FAIL %s\n", what); fails++; } } while (0)

static int pipe_fail_at, pipes, fork_fail, bad_kills, bad_waits, kills;

int __real_pipe2(int fd[2], int flags);
pid_t __real_fork(void);
int __real_kill(pid_t p, int sig);
pid_t __real_waitpid(pid_t p, int *st, int opt);

int __wrap_pipe2(int fd[2], int flags)
{
    if (++pipes == pipe_fail_at) { errno = EMFILE; return -1; }
    return __real_pipe2(fd, flags);
}
pid_t __wrap_fork(void)
{
    if (fork_fail) { errno = EAGAIN; return -1; }
    return __real_fork();
}
int __wrap_kill(pid_t p, int sig)
{
    if (p <= 0) { bad_kills++; return 0; }
    kills++;
    return __real_kill(p, sig);
}
pid_t __wrap_waitpid(pid_t p, int *st, int opt)
{
    if (p <= 0) { bad_waits++; errno = ECHILD; return -1; }
    return __real_waitpid(p, st, opt);
}

static int open_fds(void)
{
    int n = 0;
    for (int fd = 0; fd < 1024; fd++) n += fcntl(fd, F_GETFD) >= 0;
    return n;
}

int main(void)
{
    int base = open_fds();

    pipes = 0; pipe_fail_at = 2;
    CHECK(gate_start("cat > /dev/null") < 0, "the second pipe fails: not started");
    CHECK(open_fds() == base, "the first pipe is closed again");
    CHECK(gate_fd() < 0, "no gate to poll");
    pipe_fail_at = 0;

    fork_fail = 1;
    CHECK(gate_start("cat > /dev/null") < 0, "fork fails: not started");
    CHECK(open_fds() == base, "both pipes are closed again");
    gate_stop();
    CHECK(!bad_kills, "stop after a failed fork signals nothing");
    CHECK(!bad_waits, "stop after a failed fork waits for nothing");
    fork_fail = 0;

    CHECK(gate_start("cat > /dev/null") == 0, "the next try starts the gate");
    CHECK(gate_fd() >= 0, "its reports can be polled");
    gate_stop();
    CHECK(kills == 1 && !bad_kills && !bad_waits, "stop ends that child only");
    CHECK(gate_fd() < 0 && open_fds() == base, "stop closes its pipes");
    gate_stop();
    CHECK(kills == 1 && !bad_kills && !bad_waits, "a second stop does nothing");

    if (fails) { printf("test_gate: %d failed\n", fails); return 1; }
    puts("test_gate: all passed");
    return 0;
}
