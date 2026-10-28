'use strict';
// 中文翻譯：抖音 小白科技杂物社 / BiliBili 小白151 / GitHub JackieZ123430.
// Widgets have a separate StringBundle; never use the full app's dynamic slots.
const { t } = require('./i18n');
const SLOT_COUNT = 64;
const slotId = (n) => 'SID_WIDGET_DYNAMIC_' + ('0000' + n).slice(-4);
class WidgetText {
    constructor() {
        this.entries = new Map();
        this.free = Array.from({ length: SLOT_COUNT }, (_, i) => SLOT_COUNT - i - 1);
        this.tail = Promise.resolve();
        this.active = true;
    }
    set(component, spawnId, cell, value) {
        if (!this.active) return Promise.resolve();
        const key = JSON.stringify([Number(spawnId), cell]);
        let entry = this.entries.get(key);
        if (!entry) {
            entry = { spawnId: Number(spawnId), slot: null, valid: true, last: null };
            this.entries.set(key, entry);
        }
        const text = t(value);
        const unicode = /[^\x20-\x7e]/.test(text);
        if (unicode && entry.slot === null) {
            if (!this.free.length) return Promise.reject(new Error('Widget text resource pool exhausted'));
            entry.slot = this.free.pop();
        }
        // Serialize bundle writes, including released/reused slots, so a delayed old
        // update cannot overwrite another widget's string or a newer ASCII value.
        const task = this.tail.catch(() => {}).then(async () => {
            if (!this.active || !entry.valid || entry.last === text) return;
            if (unicode) {
                const sid = slotId(entry.slot), strings = {};
                strings[sid] = text;
                await component.getStringBundle().setStrings(strings);
                if (!this.active || !entry.valid) return;
                await component.setValue(Number(spawnId), cell, sid, 'StringId');
            } else {
                await component.setValue(Number(spawnId), cell, text, 'Text');
            }
            entry.last = text;
        });
        this.tail = task;
        return task;
    }
    invalidate(spawnId) {
        this.entries.forEach((entry) => { if (entry.spawnId === Number(spawnId)) entry.last = null; });
    }
    release(spawnId) {
        this.entries.forEach((entry, key) => {
            if (entry.spawnId !== Number(spawnId)) return;
            entry.valid = false;
            if (entry.slot !== null) this.free.push(entry.slot);
            this.entries.delete(key);
        });
    }
    dispose() {
        this.active = false;
        this.entries.forEach((entry) => { entry.valid = false; });
        this.entries.clear();
    }
}
module.exports = { WidgetText, SLOT_COUNT, slotId };
