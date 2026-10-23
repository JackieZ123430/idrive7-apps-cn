#!/usr/bin/env python3
"""sigdoc.py <iface> [field...] : print fields (getter/notifier) and their struct members from the master catalog."""
import json, sys, os
db = json.load(open(os.path.join(os.path.dirname(__file__), '..', '..', 'reference', 'someip-interfaces.json'), encoding='utf-8'))
def typ(ref, depth=0):
    d = db['datatypes'].get(ref)
    if not d: return ref
    if d['type'] == 'struct':
        mem = []
        dd = d
        while True:
            mem = dd.get('members', []) + mem
            if not dd.get('extends'): break
            dd = db['datatypes'][dd['extends']]
        if depth > 1: return 'struct'
        return '{' + ', '.join(m['name'] + ':' + typ(m['dataRef'], depth + 1) for m in mem) + '}'
    if d['type'] == 'enum': return 'enum(' + ','.join(f'{k}={v}' for k, v in list(d['items'].items())[:8]) + (',..' if len(d['items']) > 8 else '') + ')'
    if d['type'] == 'typedef': return typ(d.get('dataRef', d.get('baseType', '?')), depth)
    if d['type'] == 'array': return '[' + typ(d.get('elementDataRef', '?'), depth + 1) + ']'
    return d['type']
i = db['interfaces'][sys.argv[1]]
print(sys.argv[1], 'svc', i['serviceId'], 'inst', db['instanceIDs'].get(sys.argv[1]))
for f, fd in i.get('fields', {}).items():
    if len(sys.argv) > 2 and f not in sys.argv[2:]: continue
    print(' ', f, 'get' if fd.get('getter') else '', 'evt' if fd.get('notifier') else '', '=', typ(fd['dataRef'])[:700])
