'use strict';
/**
 * themes.js - colour schemes for kit-drawn screens. Picked per app in its
 * settings ("theme"); 'auto' follows nothing fancy and just means m_red, the
 * look of the sport/M HMI skin this unit runs.
 */
const THEMES = {
    m_red: {
        name: 'M Red',
        bg: '#000000', panelTop: '#1b1c20', panelBottom: '#0c0c0e', panelEdge: '#2c2d33',
        tab: '#e6e6e6', track: '#26272c', tick: '#5d5f66', text: '#ffffff', dim: '#8d9098',
        accent: '#e1001a', accent2: '#ff5a5f', ok: '#e1001a', warn: '#ffb31a', crit: '#ff1f1f', cold: '#3d8bff',
        glow: '#e1001a55', stripes: ['#e1001a'],
    },
    m_tricolour: {
        name: 'M Tricolour',
        bg: '#000000', panelTop: '#1a1c22', panelBottom: '#0b0c10', panelEdge: '#2b2e36',
        tab: '#e6e6e6', track: '#25272e', tick: '#5b5f6a', text: '#ffffff', dim: '#8a8f9a',
        accent: '#2a8cff', accent2: '#8cc8ff', ok: '#2a8cff', warn: '#ffb31a', crit: '#ef2b2d', cold: '#7fd1ff',
        glow: '#2a8cff55', stripes: ['#81c4ff', '#16588e', '#e7222e'],
    },
    ice: {
        name: 'Ice White',
        bg: '#000000', panelTop: '#1d1f22', panelBottom: '#0d0e10', panelEdge: '#30333a',
        tab: '#ffffff', track: '#26282d', tick: '#62666e', text: '#ffffff', dim: '#9aa0a8',
        accent: '#e9f2ff', accent2: '#ffffff', ok: '#e9f2ff', warn: '#ffc94d', crit: '#ff4040', cold: '#8fd3ff',
        glow: '#e9f2ff40', stripes: ['#e9f2ff'],
    },
    amber: {
        name: 'Night Amber',
        bg: '#000000', panelTop: '#1c1a17', panelBottom: '#0d0c0a', panelEdge: '#2f2b25',
        tab: '#ffb000', track: '#27241f', tick: '#655d50', text: '#ffe2b0', dim: '#9a8a70',
        accent: '#ff9d00', accent2: '#ffc65c', ok: '#ff9d00', warn: '#ffd000', crit: '#ff3b1f', cold: '#7fb7ff',
        glow: '#ff9d0050', stripes: ['#ff9d00'],
    },
};

function theme(id) { return THEMES[id] || THEMES.m_red; }
const ids = () => Object.keys(THEMES);

module.exports = { THEMES, theme, ids };
