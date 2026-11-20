'use strict';
/**
 * picker.js - Live Data's sheets (kit/sheet.js: drawn over the page where the kit runs the screen).
 *
 *   valueSheet(o)  a gauge's value in two steps: the groups (car signals, the trip computer, the engine
 *                  unit's values ...), then that group's values with what each reads now; under the
 *                  groups the screen's layout and, for a screen made already, its removal. o:
 *                    title             the sheet's heading ('Gauge 2')
 *                    groups()          [{ name, items: [{ key, fav, name, text() -> { text, dim } }] }]
 *                    current           the key the gauge has (null: none)
 *                    choose(c)         c = [key, fav] or null (an empty gauge)
 *                    layouts, layout   [{ id, name }], the screen's; setLayout(id)
 *                    remove()          (optional) removes the screen
 *   priceSheet(o)  the fuel price: buttons 10 / 1.00 / 0.10 / 0.01, the knob a step that fits the price (0.10
 *                  under 20, 1 under 200, else 10: HUF, CZK or JPY prices in hundreds). o:
 *                    price(), nudge(by), keep(), currency()
 *
 * Both: a finger drags the list (scroll / release), the knob moves the choice (move), press takes it,
 * push left (back) goes up a step or closes.
 */
const { withAlpha } = require('./kit/canvas');
const { list, pill, TOP } = require('./kit/sheet');
const { t: translate } = require('./kit/i18n');

const W = 1600;

function valueSheet(o) {
    const groups = o.groups();
    // where the gauge's value is: that group, that row
    let gi = -1, ii = -1;
    groups.forEach((g, i) => g.items.forEach((it, j) => { if (it.key === o.current) { gi = i; ii = j; } }));
    const LAYOUT = { name: 'Screen layout', layout: true };
    const layoutName = () => (o.layouts.find((l) => l.id === o.layout) || o.layouts[0]).name;
    return {
        title: o.title,
        open: null,                      // the group listed (LAYOUT: the layouts; null: the groups)
        focus: gi >= 0 ? gi + 1 : 0,     // in the groups: 0 = none (an empty gauge), then the groups, the layout, remove
        sub: 0,
        controller: false,
        rows() {
            if (this.open === LAYOUT) return o.layouts.map((l) => ({ label: l.name, kind: 'radio', on: l.id === o.layout }));
            if (this.open) return this.open.items.map((it) => { const v = it.text(); return { label: it.name, value: v.text, kind: 'radio', on: it.key === o.current }; });
            return [{ label: 'None (an empty gauge)', kind: 'radio', on: o.current === null }]
                .concat(groups.map((g, i) => ({ label: g.name, value: i === gi ? translate('now') + ': ' + g.items[ii].name : String(g.items.length), kind: 'more' })))
                .concat([{ label: 'Screen layout', value: layoutName(), kind: 'more' }],
                    o.remove ? [{ label: this.armed() ? 'Press again to remove this screen' : 'Remove this screen' }] : []);
        },
        key() { return this.open ? 'value:' + this.open.name : 'value:groups'; },
        draw(r, t) {
            r.clear(t.bg);
            r.text(this.open ? this.open.name : o.title, 44, TOP + 40, 32, t.text, { font: 'bold' });
            const targets = [], bw = 150, bx = W - 40 - bw, by = TOP + 8;
            pill(r, t, bx, by, bw, 46, this.open ? 'Back' : 'Close', this.controller && this.at() === -1);
            targets.push({ x: bx - 10, y: by - 6, w: bw + 20, h: 58, act: () => this.back() });
            list(r, t, this.key(), this.rows(), this.at(), TOP + 74, this.controller).forEach((q) => targets.push(Object.assign(q, {
                act: () => { if (this.open) this.sub = q.i; else this.focus = q.i; return this.take(); },
            })));
            return targets;
        },
        armedAt: 0,
        armed() { return Date.now() - this.armedAt < 5000; },
        /** the values listed now (read while the sheet shows them) */
        listed() { return this.open && this.open !== LAYOUT ? this.open.items : []; },
        at() { return this.open ? this.sub : this.focus; },
        top() { return this.at() === -1; },
        scroll(dy) { const st = list.scroll[this.key()]; if (st) { st.y += dy; st.drag = true; } },
        release() { const st = list.scroll[this.key()]; if (st) st.drag = false; },
        move(d) {
            this.controller = true;
            const n = this.rows().length;
            if (this.open) this.sub = Math.max(-1, Math.min(n - 1, this.sub + d));
            else this.focus = Math.max(-1, Math.min(n - 1, this.focus + d));
        },
        press() {
            this.controller = true;
            return this.at() === -1 ? this.back() : this.take();
        },
        take() {
            if (this.open === LAYOUT) {
                const l = o.layouts[this.sub];
                if (l) { o.setLayout(l.id); o.layout = l.id; }
                this.open = null;
                return null;
            }
            if (this.open) {
                const it = this.open.items[this.sub];
                if (!it) return null;
                o.choose([it.key, it.fav]);
                return 'close';
            }
            if (this.focus === 0) { o.choose(null); return 'close'; }
            if (this.focus === groups.length + 1) {
                this.open = LAYOUT;
                this.sub = Math.max(0, o.layouts.findIndex((l) => l.id === o.layout));
                return null;
            }
            if (this.focus === groups.length + 2 && o.remove) {
                // once marks it, again within 5 s removes it (a touch can't remove a screen by chance)
                if (this.armed()) { o.remove(); return 'close'; }
                this.armedAt = Date.now();
                return null;
            }
            const g = groups[this.focus - 1];
            if (!g) return null;
            this.open = g;
            this.sub = Math.max(0, g.items.findIndex((it) => it.key === o.current));
            return null;
        },
        back() {
            if (this.open) { this.open = null; return null; }
            return 'close';
        },
    };
}

function priceSheet(o) {
    const steps = [[-10, '-10'], [-1, '-1.00'], [-0.1, '-0.10'], [-0.01, '-0.01'], [0.01, '+0.01'], [0.1, '+0.10'], [1, '+1.00'], [10, '+10']];
    const knob = () => (o.price() < 20 ? 0.1 : o.price() < 200 ? 1 : 10);
    const keep = () => { o.keep(); return 'close'; };
    return {
        title: 'Fuel price',
        draw(r, t) {
            r.clear(t.bg);
            r.text('FUEL PRICE', 800, 104, 24, t.dim, { align: 'center', font: 'bold', spacing: 2 });
            r.text(o.price().toFixed(2), 800, 232, 120, t.text, { align: 'center', font: 'num' });
            r.text(o.currency() + ' a litre', 800, 278, 26, t.dim, { align: 'center' });
            const targets = [], bw = 168, gap = 12, x0 = 800 - (steps.length * bw + (steps.length - 1) * gap) / 2, by = 318;
            steps.forEach(([d, label], i) => {
                const bx = x0 + i * (bw + gap);
                r.roundRect(bx, by, bw, 64, 32, withAlpha('#ffffff', 0.08));
                r.strokeRoundRect(bx, by, bw, 64, 32, 1.5, withAlpha('#ffffff', 0.25));
                r.text(label, bx + bw / 2, by + 43, 28, t.text, { align: 'center', font: 'bold' });
                targets.push({ x: bx, y: by, w: bw, h: 64, act: () => { o.nudge(d); return null; } });
            });
            const kw = 260, kx = 800 - kw / 2, ky = 404;
            r.roundRect(kx, ky, kw, 64, 32, withAlpha(t.sel || t.accent, 0.9));
            r.text('KEEP', 800, ky + 43, 28, '#ffffff', { align: 'center', font: 'bold', spacing: 1.5 });
            targets.push({ x: kx, y: ky, w: kw, h: 64, act: keep });
            const k = knob();
            r.text('Knob: ±' + (k < 1 ? k.toFixed(2) : k) + '  ·  press: keep  ·  this trip, and trips that had no price, follow it; the others keep theirs', 800, 500, 20, t.dim, { align: 'center' });
            return targets;
        },
        move(d) { o.nudge(d * knob()); },
        press: keep,
        back: keep,
        top() { return true; },
    };
}

module.exports = { valueSheet, priceSheet };
