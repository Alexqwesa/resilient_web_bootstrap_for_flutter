(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.FlutterBootstrapHelpers = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function inferBootstrapScriptSrc(documentRef) {
    const current = documentRef.currentScript && documentRef.currentScript.src;
    if (current) {
      return current;
    }

    const scripts = documentRef.getElementsByTagName('script');
    for (let i = scripts.length - 1; i >= 0; i--) {
      const src = scripts[i] && scripts[i].src;
      if (src && /\/flutter_bootstrap\.js(?:\?|$)/.test(src)) {
        return src;
      }
    }

    return '';
  }

  function resolveBuildBase(options) {
    const injectedBuild = options && options.injectedBuild;
    const scriptSrc = options && options.scriptSrc;

    let build = injectedBuild;
    if (!build && scriptSrc) {
      const match = scriptSrc.match(/\/version\/([^/]+)\/flutter_bootstrap\.js(?:\?|$)/);
      if (match) {
        build = match[1];
      }
    }

    if (!build) {
      return { build: null, base: '/' };
    }

    return { build, base: `/version/${build}/` };
  }

  function toAbsoluteUrl(url, baseHref) {
    try {
      return new URL(url, baseHref || 'https://example.invalid/').href;
    } catch (_) {
      return typeof url === 'string' ? url : '';
    }
  }

  function chooseCanvasKitBase(options) {
    const buildBase = options && options.buildBase ? options.buildBase : '/';
    const crossOriginIsolated =
      options && options.crossOriginIsolated === true;

    return crossOriginIsolated
      ? `${buildBase}canvaskit/chromium/`
      : `${buildBase}canvaskit/`;
  }

  function isTrackedCanvasKitWasmRequest(url, absoluteCanvasKitBase, baseHref) {
    if (typeof url !== 'string' || !url) {
      return false;
    }

    const absoluteUrl = toAbsoluteUrl(url, baseHref);
    return (
      absoluteUrl.startsWith(absoluteCanvasKitBase) &&
      /\/canvaskit\.wasm(?:$|\?)/.test(absoluteUrl)
    );
  }

  function isTrackedAppEntrypointRequest(url, absoluteBuildBase, baseHref) {
    if (typeof url !== 'string' || !url) {
      return false;
    }

    const absoluteUrl = toAbsoluteUrl(url, baseHref);
    if (!absoluteUrl.startsWith(absoluteBuildBase)) {
      return false;
    }

    return /\/(main\.dart\.(?:js|mjs)|main_module\.bootstrap\.js)(?:$|\?)/.test(
      absoluteUrl,
    );
  }

  return {
    inferBootstrapScriptSrc,
    resolveBuildBase,
    toAbsoluteUrl,
    chooseCanvasKitBase,
    isTrackedCanvasKitWasmRequest,
    isTrackedAppEntrypointRequest,
  };
});
