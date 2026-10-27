'use strict';
// Chinese Unicode support: Bilibili 小白151 / GitHub JackieZ123430.
// RHMI Text is not a reliable Unicode transport on this firmware. Use the SDK's
// UTF-8 StringBundle and StringId handles for non-ASCII values instead.
const { t } = require('./i18n');
const SLOT_COUNT = 1024;
const slotId = (n) => 'SID_CN_DYNAMIC_' + ('0000' + n).slice(-4);
class HmiText {
    constructor() { this.slots = new Map(); this.requests = new Map(); }
    set(component, name, row, cell, value) {
        const key = JSON.stringify([name, row, cell]);
        this.requests.set(key, [component, name, row, cell, value]);
        const text = t(value);
        if (!/[^\x20-\x7e]/.test(text)) return component.setValue(row, cell, text, 'Text');
        if (!this.slots.has(key)) {
            if (this.slots.size >= SLOT_COUNT) return Promise.reject(new Error('Chinese text resource pool exhausted'));
            this.slots.set(key, slotId(this.slots.size));
        }
        const sid = this.slots.get(key), bundle = component.getStringBundle();
        const strings = {}; strings[sid] = text;
        return bundle.setStrings(strings).then(() => component.setValue(row, cell, sid, 'StringId'));
    }
    refresh() { return Promise.all(Array.from(this.requests.values()).map((args) => this.set.apply(this, args))); }
}
module.exports = { HmiText, SLOT_COUNT, slotId };
