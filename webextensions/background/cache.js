/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

async function restoreWindowFromEffectiveWindowCache(aWindowId, aOptions = {}) {
  gMetricsData.add('restoreWindowFromEffectiveWindowCache start');
  log('restoreWindowFromEffectiveWindowCache start');
  var owner = aOptions.owner || getWindowCacheOwner(aWindowId);
  if (!owner) {
    log('restoreWindowFromEffectiveWindowCache fail: no owner');
    return false;
  }
  cancelReservedCacheTree(aWindowId); // prevent to break cache before loading
  var tabs  = aOptions.tabs || await browser.tabs.query({ windowId: aWindowId });
  log('restoreWindowFromEffectiveWindowCache tabs: ', tabs);
  var [actualSignature, cache] = await Promise.all([
    getWindowSignature(tabs),
    getWindowCache(owner, kWINDOW_STATE_CACHED_TABS)
  ]);
  var cachedSignature = cache && cache.signature;
  log(`restoreWindowFromEffectiveWindowCache: got from the owner ${owner}`, {
    cachedSignature, cache
  });
  if (cache &&
      cache.tabs &&
      cachedSignature &&
      cachedSignature != signatureFromTabsCache(cache.tabs)) {
    log(`restoreWindowFromEffectiveWindowCache: cache for ${aWindowId} is broken.`, {
      signature: cachedSignature,
      cache:     signatureFromTabsCache(cache.tabs)
    });
    cache = cachedSignature = null;
    clearWindowCache(aWindowId);
  }
  if (aOptions.ignorePinnedTabs &&
      cache &&
      cache.tabs &&
      cachedSignature) {
    cache.tabs      = trimTabsCache(cache.tabs, cache.pinnedTabsCount);
    cachedSignature = trimSignature(cachedSignature, cache.pinnedTabsCount);
  }
  var signatureMatched = matcheSignatures({
    actual: actualSignature,
    cached: cachedSignature
  });
  log(`restoreWindowFromEffectiveWindowCache: verify cache for ${aWindowId}`, {
    cache, actualSignature, cachedSignature, signatureMatched
  });
  if (!cache ||
      cache.version != kSIDEBAR_CONTENTS_VERSION ||
      !signatureMatched) {
    log(`restoreWindowFromEffectiveWindowCache: no effective cache for ${aWindowId}`);
    clearWindowCache(owner);
    gMetricsData.add('restoreWindowFromEffectiveWindowCache fail');
    return false;
  }
  cache.offset = actualSignature.replace(cachedSignature, '').trim().split('\n').filter(aPart => !!aPart).length;

  log(`restoreWindowFromEffectiveWindowCache: restore ${aWindowId} from cache`);

  var insertionPoint  = aOptions.insertionPoint;
  if (!insertionPoint) {
    insertionPoint = document.createRange();
    let container = getTabsContainer(aWindowId);
    if (container)
      insertionPoint.selectNode(container);
    else
      insertionPoint.selectNodeContents(gAllTabs);
    insertionPoint.collapse(false);
  }
  var restored = restoreTabsFromCache(aWindowId, {
    insertionPoint, cache, tabs
  });
  if (!aOptions.insertionPoint)
    insertionPoint.detach();

  if (restored)
    gMetricsData.add('restoreWindowFromEffectiveWindowCache success');
  else
    gMetricsData.add('restoreWindowFromEffectiveWindowCache fail');

  return restored;
}

function restoreTabsFromCache(aWindowId, aParams = {}) {
  if (!aParams.cache ||
      aParams.cache.version != kBACKGROUND_CONTENTS_VERSION)
    return false;

  log(`restoreTabsFromCache: restore tabs for ${aWindowId} from cache `, aParams.cache);

  var offset         = aParams.cache.offset || 0;
  var apiTabs        = aParams.tabs.slice(offset);
  var tabElements;
  var insertionPoint = aParams.insertionPoint;
  var container      = getTabsContainer(aWindowId);;
  if (offset > 0) {
    if (!container ||
        container.childNodes.length <= offset) {
      log('restoreTabsFromCache: missing container');
      return false;
    }
    log(`restoreTabsFromCache: there is ${container.childNodes.length} tabs`);
    insertionPoint = document.createRange();
    insertionPoint.selectNodeContents(container);
    log('restoreTabsFromCache: delete obsolete tabs, offset = ', offset);
    // for safety, now I use actual ID string instead of short way.
    insertionPoint.setStartBefore(getTabById(makeTabId(apiTabs[0])));
    insertionPoint.deleteContents();
    let tabsMustBeRemoved = apiTabs.map(aApiTab => getTabById(makeTabId(aApiTab)));
    log('restoreTabsFromCache: cleared?: ', tabsMustBeRemoved.every(aTab => !aTab), tabsMustBeRemoved.map(dumpTab));
    log(`restoreTabsFromCache: => ${container.childNodes.length} tabs left`);
    let matched = aParams.cache.tabs.match(/<li/g);
    log(`restoreTabsFromCache: restore ${matched.length} tabs from cache`);
    let fragment = insertionPoint.createContextualFragment(aParams.cache.tabs.replace(/^<ul[^>]+>|<\/ul>$/g, ''));
    insertionPoint.insertNode(fragment);
    insertionPoint.detach();
    tabElements = Array.slice(container.childNodes, -matched.length);
  }
  else {
    if (container)
      container.parentNode.removeChild(container);
    let fragment = aParams.insertionPoint.createContextualFragment(aParams.cache.tabs);
    container = fragment.firstChild;
    log('restoreTabsFromCache: restore');
    insertionPoint.insertNode(fragment);
    container.id = `window-${aWindowId}`;
    container.dataset.windowId = aWindowId;
    tabElements = Array.slice(container.childNodes);
  }

  log('restoreTabsFromCache: post process ', { tabElements, apiTabs });
  if (tabElements.length != apiTabs.length) {
    log('restoreTabsFromCache: Mismatched number of restored tabs? ');
    return true;
  }
  try{
    fixupTabsRestoredFromCache(tabElements, apiTabs, {
      dirty: true
    });
  }
  catch(e) {
    log(String(e), e.stack);
    throw e;
  }
  log('restoreTabsFromCache: done', configs.debug && getTreeStructureFromTabs(getAllTabs(aWindowId)));
  dumpAllTabs();
  return true;
}


function updateWindowCache(aOwner, aKey, aValue) {
  if (!aOwner ||
      !getTabById(aOwner))
    return;
  if (aValue === undefined) {
    //browser.sessions.removeWindowValue(aOwner, aKey);
    browser.sessions.removeTabValue(aOwner, aKey);
  }
  else {
    //browser.sessions.setWindowValue(aOwner, aKey, aValue);
    browser.sessions.setTabValue(aOwner, aKey, aValue);
  }
}

function clearWindowCache(aOwner) {
  log('clearWindowCache for owner ', aOwner, { stack: new Error().stack });
  updateWindowCache(aOwner, kWINDOW_STATE_CACHED_TABS);
  updateWindowCache(aOwner, kWINDOW_STATE_CACHED_SIDEBAR);
  updateWindowCache(aOwner, kWINDOW_STATE_CACHED_SIDEBAR_TABS_DIRTY);
  updateWindowCache(aOwner, kWINDOW_STATE_CACHED_SIDEBAR_COLLAPSED_DIRTY);
}

function markWindowCacheDirtyFromTab(aTab, akey) {
  var container = aTab.parentNode;
  updateWindowCache(container.lastWindowCacheOwner, akey, true);
}

async function getWindowCache(aOwner, aKey) {
  //return browser.sessions.getWindowValue(aOwner, aKey);
  return browser.sessions.getTabValue(aOwner, aKey);
}

function getWindowCacheOwner(aHint) {
  return getLastTab(aHint).apiTab.id;
}

async function reserveToCacheTree(aHint) {
  if (gInitializing ||
      !configs.useCachedTree)
    return;

  // If there is any opening (but not resolved its unique id yet) tab,
  // we are possibly restoring tabs. To avoid cache breakage before
  // restoration, we must wait until we know whether there is any other
  // restoring tab or not.
  if (hasCreatingTab())
    await waitUntilAllTabsAreaCreated();

  if (!aHint ||
      aHint instanceof Node && !aHint.parentNode)
    return;

  var container = getTabsContainer(aHint);
  if (!container)
    return;

  if (container.allTabsRestored)
    return;

  var windowId = parseInt(container.dataset.windowId);
  log('reserveToCacheTree for window ', windowId, { stack: new Error().stack });
  clearWindowCache(container.lastWindowCacheOwner);

  if (container.waitingToCacheTree)
    clearTimeout(container.waitingToCacheTree);
  container.waitingToCacheTree = setTimeout(() => {
    cacheTree(windowId);
  }, 500);
}

function cancelReservedCacheTree(aWindowId) {
  var container = getTabsContainer(aWindowId);
  if (container && container.waitingToCacheTree) {
    clearTimeout(container.waitingToCacheTree);
    delete container.waitingToCacheTree;
  }
}

async function cacheTree(aWindowId) {
  if (hasCreatingTab())
    await waitUntilAllTabsAreaCreated();
  var container = getTabsContainer(aWindowId);
  if (!container ||
      !configs.useCachedTree)
    return;
  var signature = await getWindowSignature(aWindowId);
  if (container.allTabsRestored)
    return;
  //log('save cache for ', aWindowId);
  container.lastWindowCacheOwner = getWindowCacheOwner(aWindowId);
  if (!container.lastWindowCacheOwner)
    return;
  log('cacheTree for window ', aWindowId, { stack: new Error().stack });
  updateWindowCache(container.lastWindowCacheOwner, kWINDOW_STATE_CACHED_TABS, {
    version: kBACKGROUND_CONTENTS_VERSION,
    tabs:    container.outerHTML,
    pinnedTabsCount: getPinnedTabs(container).length,
    signature
  });
}