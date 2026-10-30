// emu_lib.js - the WebGL 2 context for emu_gfx.c, on the canvas given to the module (Module.canvas).
// No multisampling: gfx.c anti-aliases by itself, and the surface is blitted to the canvas.
addToLibrary({
    emu_gl_context__deps: ['$GL'],
    emu_gl_context: () => {
        const h = GL.createContext(Module['canvas'], {
            majorVersion: 2, minorVersion: 0, alpha: true, premultipliedAlpha: true, antialias: false,
            depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'high-performance',
        });
        return h && GL.makeContextCurrent(h) ? h : 0;
    },
    // the context lost for good (frees the GPU's slot at once: browsers keep ~16) and forgotten
    emu_gl_destroy__deps: ['$GL'],
    emu_gl_destroy: () => {
        const c = GL.currentContext;
        if (!c) return;
        const lose = c.GLctx.getExtension('WEBGL_lose_context');
        GL.makeContextCurrent(0);
        GL.deleteContext(c.handle);
        if (lose && !c.GLctx.isContextLost()) lose.loseContext();
    },
});
