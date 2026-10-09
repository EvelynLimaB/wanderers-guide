// ==UserScript==
// @name         Wanderer's Guide - Pathbuilder Export Bridge
// @namespace    https://github.com/EvelynLimaB/wanderers-guide
// @version      1.0.0
// @description  Sends Pathbuilder's own calculated Export JSON to a Wanderer's Guide import tab.
// @match        https://pathbuilder2e.com/app.html*
// @run-at       document-start
// @grant        none
// @inject-into  page
// ==/UserScript==
(() => {
  'use strict';

  const ORIGIN = 'https://pathbuilder2e.com';
  const REQUEST = 'WG_PATHBUILDER_EXPORT_REQUEST';
  const RESULT = 'WG_PATHBUILDER_EXPORT_RESULT';
  const ERROR = 'WG_PATHBUILDER_EXPORT_ERROR';

  let loadedShareId = null;
  let activeExport = null;
  const handledNonces = new Set();

  function sendToOpener(targetOrigin, message) {
    if (!window.opener || window.opener.closed || !targetOrigin || targetOrigin === 'null') return;
    window.opener.postMessage(message, targetOrigin);
  }

  function failRequest(request, message) {
    if (activeExport?.nonce === request.nonce) activeExport = null;
    sendToOpener(request.targetOrigin, {
      type: ERROR,
      nonce: request.nonce,
      shareId: request.shareId,
      error: message,
    });
  }

  function getRequestBody(body) {
    if (typeof body !== 'string') return null;
    try {
      const parsed = JSON.parse(body);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  // Observe the official share request so we refuse to export a different character.
  const XHR = window.XMLHttpRequest;
  const proto = XHR && XHR.prototype;
  if (!proto || proto.__wgPathbuilderBridgeInstalled) return;
  Object.defineProperty(proto, '__wgPathbuilderBridgeInstalled', { value: true });

  const originalOpen = proto.open;
  const originalSend = proto.send;

  proto.open = function(method, url) {
    try {
      this.__wgPathbuilderPath = new URL(String(url), window.location.href).pathname;
    } catch {
      this.__wgPathbuilderPath = '';
    }
    return originalOpen.apply(this, arguments);
  };

  proto.send = function(body) {
    const path = this.__wgPathbuilderPath;
    const reqBody = getRequestBody(body);

    if (path === '/app/fetch_emailed.php' && reqBody && /^\d+$/.test(String(reqBody.id ?? ''))) {
      const requestedShareId = String(reqBody.id);
      this.addEventListener('load', () => {
        if (this.status !== 200) return;
        try {
          const response = JSON.parse(this.responseText);
          if (response?.success === true) loadedShareId = requestedShareId;
        } catch {
          // Leave the ID unset when the share response is invalid.
        }
      }, { once: true });
    }

    const request = activeExport;
    if (path === '/app/post_json.php' && request && reqBody && reqBody.build) {
      const outgoing = reqBody;
      this.addEventListener('load', () => {
        if (activeExport?.nonce !== request.nonce) return;
        if (this.status < 200 || this.status >= 300) {
          failRequest(request, 'Pathbuilder could not save its calculated JSON export (HTTP ' + this.status + ').');
          return;
        }
        try {
          const response = JSON.parse(this.responseText);
          const derived = outgoing.build;
          if (
            !response ||
            !/^\d+$/.test(String(response.id ?? '')) ||
            typeof derived.name !== 'string' ||
            typeof derived.class !== 'string' ||
            typeof derived.level !== 'number'
          ) {
            failRequest(request, 'Pathbuilder export response is missing its ID or character identity.');
            return;
          }

          activeExport = null;
          sendToOpener(request.targetOrigin, {
            type: RESULT,
            nonce: request.nonce,
            shareId: request.shareId,
            exportId: String(response.id),
            derived,
          });
        } catch {
          failRequest(request, 'Pathbuilder export did not return valid JSON.');
        }
      }, { once: true });
    }

    return originalSend.apply(this, arguments);
  };

  function waitForCharacter(expectedShareId) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = window.setInterval(() => {
        if (!window.opener || window.opener.closed) {
          window.clearInterval(timer);
          reject(new Error('The Wanderer’s Guide import window was closed.'));
          return;
        }

        const main = document.getElementById('main-container');
        const levelList = document.getElementById('divBuildLevels');
        const ready =
          document.readyState !== 'loading' &&
          main &&
          !main.classList.contains('hidden') &&
          levelList &&
          levelList.children.length > 0 &&
          document.getElementById('sidenav-json');

        if (ready && loadedShareId === expectedShareId) {
          window.clearInterval(timer);
          resolve();
          return;
        }

        if (Date.now() - started > 60000) {
          window.clearInterval(timer);
          reject(new Error(
            loadedShareId && loadedShareId !== expectedShareId
              ? 'Pathbuilder loaded share ' + loadedShareId + ' instead of requested share ' + expectedShareId + '.'
              : 'Pathbuilder did not finish loading the requested shared character.'
          ));
        }
      }, 250);
    });
  }

  window.addEventListener('message', async (event) => {
    if (event.origin === 'null' || event.origin === ORIGIN) return;
    if (!window.opener || event.source !== window.opener) return;

    const request = event.data;
    if (!request || request.type !== REQUEST) return;
    if (typeof request.nonce !== 'string' || request.nonce.length < 16 || request.nonce.length > 128) return;
    if (typeof request.shareId !== 'string' || !/^\d+$/.test(request.shareId)) return;
    if (handledNonces.has(request.nonce)) return;
    handledNonces.add(request.nonce);

    const targetOrigin = event.origin;
    try {
      await waitForCharacter(request.shareId);

      const accepted = window.confirm(
        'Wanderer’s Guide at ' + targetOrigin +
        ' requests the calculated stats for the currently loaded Pathbuilder character ' +
        '(share ID ' + request.shareId + ').\n\n' +
        'The JSON data will be sent only to the tab that opened this window. Continue?'
      );
      if (!accepted) {
        failRequest({ ...request, targetOrigin }, 'Pathbuilder export was cancelled.');
        return;
      }

      activeExport = { ...request, targetOrigin };
      const exportButton = document.getElementById('sidenav-json');
      if (!exportButton) {
        failRequest(activeExport, 'Could not find Pathbuilder’s Export JSON menu item.');
        return;
      }

      // Trigger the official export action. The hook above captures the exact
      // calculated object Pathbuilder submits to post_json.php.
      exportButton.click();
    } catch (error) {
      failRequest(
        { ...request, targetOrigin },
        error instanceof Error ? error.message : 'Pathbuilder browser export failed.'
      );
    }
  });
})();
