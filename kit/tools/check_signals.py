#!/usr/bin/env python3
"""check_signals.py [catalog] : run from custom-apps/; checks every app.json signal flag against the catalog (r needs a getter id, s a notifier) - the unit installer rejects mismatches."""
import json,sys,glob
import os; db=json.load(open(sys.argv[1] if len(sys.argv)>1 else os.path.join(os.path.dirname(__file__),'..','..','reference','someip-interfaces.json'), encoding='utf-8'))
bad=0
for f in sorted(glob.glob('apps/*/app.json')):
    a=json.load(open(f, encoding='utf-8'))
    for iface,fields in a.get('signals',{}).items():
        i=db['interfaces'].get(iface)
        if not i: print(a['id'],'MISSING IFACE',iface); bad+=1; continue
        for k,v in fields.items():
            if k in('_methods','_broadcasts'):
                key='methods' if k=='_methods' else 'broadcasts'
                for m in v:
                    if m not in i.get('events' if key=='broadcasts' else key,{}): print(a['id'],iface,'no',key,m); bad+=1
                continue
            if k.startswith('_'): continue
            fd=i.get('fields',{}).get(k)
            if fd is None: print(a['id'],iface,'no field',k); bad+=1; continue
            if 'r' in v and not (fd.get('getter') or {}).get('id'): print(a['id'],iface,k,'no getter'); bad+=1
            if 's' in v and not fd.get('notifier'): print(a['id'],iface,k,'no notifier'); bad+=1
print("problems:",bad); sys.exit(1 if bad else 0)
