#!/usr/bin/env python3
"""make_kit.py - build the apps and pack everything the head unit needs into one folder
(+ .tar.gz) for push-to-car.sh / push-to-car.ps1 or a USB stick. Runs on Linux, macOS and
Windows (Python 3.6+ and Node.js; no bash, no Docker needed).

    python3 kit/tools/make_kit.py                 # all apps in apps/
    python3 kit/tools/make_kit.py car_vitals ...  # only these
    (deploy/make-car-kit.sh and deploy\\make-car-kit.cmd call this)

Output: dist/mgu-custom-apps/ and dist/mgu-custom-apps.tar.gz

The GPU renderer (kit/renderd) is compiled in Docker when Docker is there. Without Docker the
kit takes kit/renderd/prebuilt/mgu-renderd, which is committed to the repository together
with a fingerprint of the source it was built from. A Docker build of changed source updates
the prebuilt copy (commit it). If no renderer matching the source can be had, it asks.
"""
import gzip, hashlib, io, json, os, shutil, subprocess, sys, tarfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEPLOY = os.path.join(ROOT, 'deploy')
DIST = os.path.join(ROOT, 'dist')
OUT = os.path.join(DIST, 'mgu-custom-apps')
RENDERD = os.path.join(ROOT, 'kit', 'renderd')
BUILT = os.path.join(RENDERD, 'build', 'mgu-renderd')
PRE_DIR = os.path.join(RENDERD, 'prebuilt')
PRE = os.path.join(PRE_DIR, 'mgu-renderd')
PRE_SUM = os.path.join(PRE_DIR, 'SOURCE_SHA256')
# the renderer's script files, shipped beside it (kit and prebuilt/, which the Store installs from):
# the foreground gate it starts, the HMI page template's generator, mount script and boot guard, its licences
RENDERD_FILES = [('js/foreground_gate.js', 'foreground_gate.js'), ('js/hmi_template.js', 'hmi_template.js'),
                 ('systemd/mgu-render-hmi.sh', 'mgu-render-hmi.sh'), ('systemd/mgu-render-hmi-guard.sh', 'mgu-render-hmi-guard.sh'),
                 ('LICENSE', 'LICENSE'), ('LICENSE.mgu-renderd', 'LICENSE.mgu-renderd')]
# files copied next to the apps; text, so always shipped with Unix line endings
CAR_FILES = [('car/deploy-car.sh', 'deploy-car.sh'), ('mgu-app-install.sh', 'mgu-app-install.sh'),
             ('mainapp-patch.js', 'mainapp-patch.js'), ('car/README.txt', 'README.txt')]


def source_hash(parts=(('src', None), ('inputgate', ('.cpp',)), ('protocol', ('.xml',)), ('docker', None), ('', ('Makefile',)))):
    """Fingerprint of everything the renderer binary is built from (line endings ignored)."""
    files = []
    for sub, exts in parts:
        d = os.path.join(RENDERD, sub)
        for n in sorted(os.listdir(d)):
            p = os.path.join(d, n)
            if not os.path.isfile(p): continue
            if exts and not any(n.endswith(e) for e in exts): continue
            files.append(((sub + '/' + n).lstrip('/'), p))
    h = hashlib.sha256()
    for rel, p in files:
        h.update(rel.encode() + b'\0' + open(p, 'rb').read().replace(b'\r\n', b'\n') + b'\0')
    return h.hexdigest()


def prebuilt_hash():
    try: return open(PRE_SUM, encoding='utf-8').read().split()[0]
    except (OSError, IndexError): return None


def docker_build():
    """Compile kit/renderd in Docker (x86-64 like the head unit). Returns (ok, output, stale): stale = built in an
    image that could not be made again from this docker/."""
    plat = ['--platform', 'linux/amd64']
    user = ['-u', '%d:%d' % (os.getuid(), os.getgid())] if hasattr(os, 'getuid') else []
    log = []
    def run(cmd):
        p = subprocess.run(cmd, cwd=RENDERD, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        log.append(p.stdout.decode('utf-8', 'replace'))
        return p.returncode == 0
    # the image is made again when docker/ changed: its label holds the docker/ it was built from
    tag = source_hash((('docker', None),))
    p = subprocess.run(['docker', 'image', 'inspect', '-f', '{{index .Config.Labels "mgu-renderd.docker"}}', 'mgu-renderd-build'],
                       cwd=RENDERD, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    have = p.stdout.decode('utf-8', 'replace').strip()
    ok = have == tag or run(['docker', 'build'] + plat + ['--label', 'mgu-renderd.docker=' + tag, '-t', 'mgu-renderd-build', 'docker'])
    stale = False
    if not ok and p.returncode == 0:
        # offline, or the base image gone: the image there still builds the renderer (one without the label
        # predates it, its docker/ may well be the same)
        print('   (could not rebuild the build image; using the existing one, made from an older or unknown docker/)')
        ok = stale = True
    ok = ok and run(['docker', 'run', '--rm'] + plat + user + ['-v', RENDERD + ':/src', 'mgu-renderd-build', 'make'])
    return ok and os.path.isfile(BUILT), ''.join(log), stale


def ask(why, fallback):
    print('\n!! ' + why)
    if fallback: print('!! The kit would ship kit/renderd/prebuilt/mgu-renderd, which is OLDER than the source.')
    else: print('!! The kit would ship no renderer: the apps then draw in software (PNG, a few fps).')
    if sys.stdin is not None and sys.stdin.isatty():
        if input('Continue anyway? [y/N] ').strip().lower() not in ('y', 'yes'):
            print('stopped - nothing was built or packed'); sys.exit(1)
    else:
        print('!! (not a terminal: continuing)')
    return fallback


def pick_renderer():
    """The renderer binary to ship (path or None). Decided before anything is built."""
    want, have = source_hash(), prebuilt_hash()
    pre_ok = os.path.isfile(PRE) and have == want
    older = PRE if os.path.isfile(PRE) else None
    if shutil.which('docker'):
        ok, log, stale = docker_build()
        if ok:
            if not pre_ok and stale:
                # prebuilt/ would claim this docker/ (SOURCE_SHA256) and no later run would make it again
                print('\n'.join(log.strip().splitlines()[-15:]))
                print('renderer: built in the older build image - kit/renderd/prebuilt/ NOT updated '
                      '(fix the image build above, then run again)')
            elif not pre_ok:
                os.makedirs(PRE_DIR, exist_ok=True)
                shutil.copyfile(BUILT, PRE)
                shutil.copyfile(gate_of(BUILT), gate_of(PRE))
                with open(PRE_SUM, 'w', encoding='utf-8', newline='\n') as f:
                    f.write(want + '\n# sha256 of kit/renderd src/, inputgate/*.cpp, protocol/*.xml, docker/, Makefile '
                            '(make_kit.py source_hash) this binary was built from\n')
                print('renderer: source changed - updated kit/renderd/prebuilt/ (commit it)')
            return BUILT
        print('\n'.join(log.strip().splitlines()[-15:]))
        if pre_ok:
            print('renderer: Docker build failed - using the prebuilt one (built from this same source)')
            return PRE
        return ask('The mgu-renderd build failed (output above).', older)
    if pre_ok:
        print('renderer: prebuilt (kit/renderd/prebuilt, matches the source)')
        return PRE
    if older:
        return ask('The source in kit/renderd changed since the prebuilt renderer was made, and there is '
                   'no Docker to rebuild it (see kit/renderd/README.md).', older)
    return ask('No prebuilt renderer and no Docker to build one (see kit/renderd/README.md).', None)


def renderd_files(dest):
    """the renderer's script files into dest (Unix line endings); the names that changed"""
    changed = []
    for src, dst in RENDERD_FILES:
        data = open(os.path.join(RENDERD, src), 'rb').read().replace(b'\r\n', b'\n')
        p = os.path.join(dest, dst)
        if not os.path.isfile(p) or open(p, 'rb').read() != data:
            open(p, 'wb').write(data)
            changed.append(dst)
    return changed


def gate_of(rd):
    """the controller gate (mgu-inputgate.so, loaded into the HMI) built next to the renderer"""
    return os.path.join(os.path.dirname(rd), 'mgu-inputgate.so')


def md5(p):
    h = hashlib.md5()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''): h.update(b)
    return h.hexdigest()


def main():
    import argparse
    from localize import languages, package_version, normalize_language
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--language', type=normalize_language, choices=languages(), default='en',
                        help='UI language; Korean also accepts ko-KR, ko-kr and ko_KR, Spanish es-ES and es_ES')
    parser.add_argument('apps', nargs='*')
    args = parser.parse_args()
    # English (the default) keeps the usual dist/mgu-custom-apps(.tar.gz); other languages get a suffix
    name = 'mgu-custom-apps' + ('' if args.language == 'en' else '-' + args.language)
    OUT = os.path.join(DIST, name)
    archive = os.path.join(DIST, name + '.tar.gz')
    apps = args.apps or sorted(d for d in os.listdir(os.path.join(ROOT, 'apps'))
                                  if os.path.isfile(os.path.join(ROOT, 'apps', d, 'app.json')))
    rd = pick_renderer()

    shutil.rmtree(OUT, ignore_errors=True)
    os.makedirs(os.path.join(OUT, 'apps'))
    for app in apps:
        r = subprocess.run([sys.executable, os.path.join(ROOT, 'kit', 'tools', 'build.py'), '--language', args.language, app], cwd=ROOT)
        if r.returncode: sys.exit('build of %s failed' % app)
        spec = json.load(open(os.path.join(ROOT, 'apps', app, 'app.json'), encoding='utf-8'))
        app_id = spec.get('id', app)
        ver = spec['version']
        ver = package_version(ver, args.language)
        shutil.copyfile(os.path.join(DIST, '%s@%s.mgu' % (app_id, ver)), os.path.join(OUT, 'apps', '%s@%s.mgu' % (app_id, ver)))
    for src, dst in CAR_FILES:
        data = open(os.path.join(DEPLOY, src), 'rb').read().replace(b'\r\n', b'\n')
        open(os.path.join(OUT, dst), 'wb').write(data)
    gate = rd and os.path.isfile(gate_of(rd))
    if rd: shutil.copyfile(rd, os.path.join(OUT, 'mgu-renderd'))
    if gate: shutil.copyfile(gate_of(rd), os.path.join(OUT, 'mgu-inputgate.so'))
    if not rd: print('note: no mgu-renderd in the kit - the apps install with software rendering only')
    if rd:
        renderd_files(OUT)
        if renderd_files(PRE_DIR): print('renderer: script files changed - updated kit/renderd/prebuilt/ (commit it)')

    names = ['deploy-car.sh', 'mgu-app-install.sh', 'mainapp-patch.js'] + \
            ['apps/' + n for n in sorted(os.listdir(os.path.join(OUT, 'apps')))] + (['mgu-renderd'] if rd else []) + (['mgu-inputgate.so'] if gate else []) + \
            ([d for _, d in RENDERD_FILES] if rd else [])
    with open(os.path.join(OUT, 'KIT_SUMS'), 'w', encoding='utf-8', newline='\n') as f:
        for n in names: f.write('%s  %s\n' % (md5(os.path.join(OUT, n)), n))

    # the archive carries Unix modes (scripts and the renderer executable), also when made on Windows
    def mode(ti):
        ti.uid = ti.gid = 0; ti.uname = ti.gname = 'root'
        ti.mode = 0o755 if ti.isdir() or ti.name.endswith(('.sh', '/mgu-renderd', '.so')) else 0o644
        return ti
    # no clock in the gzip header: it holds 32 bits, past 2106 it fails (see build.py gz_header_free)
    with gzip.GzipFile(archive, 'wb', mtime=0) as gz, tarfile.open(fileobj=gz, mode='w') as tf:
        tf.add(OUT, arcname='mgu-custom-apps', filter=mode)
    if hasattr(os, 'chmod'):
        for n in ('deploy-car.sh', 'mgu-app-install.sh') + (('mgu-renderd',) if rd else ()):
            os.chmod(os.path.join(OUT, n), 0o755)
    shutil.copyfile(os.path.join(DEPLOY, 'push-to-car.ps1'), os.path.join(DIST, 'push-to-car.ps1'))  # Windows: next to the .tar.gz
    print('kit: %s  (%s)' % (OUT, ' '.join(sorted(os.listdir(os.path.join(OUT, 'apps'))))))
    print('     %s' % archive)


if __name__ == '__main__':
    main()
