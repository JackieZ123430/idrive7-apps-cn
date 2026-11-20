import gzip, hashlib, io, json, pathlib, tarfile

def normalize(source, output, app_id, version, provenance, license_path=None):
    files = {}
    with tarfile.open(source) as archive:
        for member in archive.getmembers():
            if not member.isfile():
                continue
            name = member.name.removeprefix('package/')
            if name.startswith('/') or '..' in pathlib.PurePosixPath(name).parts:
                raise ValueError('Unsafe archive path')
            if name.startswith('node_modules/oap-sdk/'):
                continue
            body = archive.extractfile(member).read()
            if name == 'package.json':
                pkg = json.loads(body)
                old = pkg['version']
            files[name] = [body, member.mode]
    assert pkg['name'] == app_id
    def replace(obj):
        if isinstance(obj, dict):
            return {key:(version if key == 'version' and val == old else replace(val)) for key,val in obj.items()}
        if isinstance(obj, list): return [replace(x) for x in obj]
        return obj
    for name, (body, mode) in list(files.items()):
        if name.endswith('.json'):
            try: body = (json.dumps(replace(json.loads(body)), ensure_ascii=False, indent=2)+'\n').encode()
            except (ValueError, UnicodeDecodeError): pass
            files[name] = [body, mode]
    files['SOURCE.zh-CN.json'] = [(json.dumps(provenance, ensure_ascii=False, indent=2)+'\n').encode(), 0o644]
    if license_path and license_path.exists() and 'LICENSE' not in files:
        files['LICENSE'] = [license_path.read_bytes(),0o644]
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('wb') as raw, gzip.GzipFile(fileobj=raw, mode='wb',mtime=0,filename='') as gz, tarfile.open(fileobj=gz,mode='w') as archive:
        for name,(body,mode) in sorted(files.items()):
            item = tarfile.TarInfo(name); item.size=len(body); item.mode=mode
            archive.addfile(item,io.BytesIO(body))
    assert not any('oap-sdk' in name for name in files)
    assert json.loads(files['package.json'][0])['version'] == version
    return {'name':output.name,'size':output.stat().st_size,'sha256':hashlib.sha256(output.read_bytes()).hexdigest()}
