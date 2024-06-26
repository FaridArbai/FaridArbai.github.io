/**
 * @license
 * Copyright 2016 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

goog.provide('shaka.media.DrmEngine');

goog.require('goog.asserts');
goog.require('shaka.log');
goog.require('shaka.net.NetworkingEngine');
goog.require('shaka.util.ArrayUtils');
goog.require('shaka.util.Error');
goog.require('shaka.util.EventManager');
goog.require('shaka.util.FakeEvent');
goog.require('shaka.util.Functional');
goog.require('shaka.util.IDestroyable');
goog.require('shaka.util.ManifestParserUtils');
goog.require('shaka.util.MapUtils');
goog.require('shaka.util.MimeUtils');
goog.require('shaka.util.PublicPromise');
goog.require('shaka.util.StringUtils');
goog.require('shaka.util.Timer');
goog.require('shaka.util.Uint8ArrayUtils');


/**
 * @param {shaka.media.DrmEngine.PlayerInterface} playerInterface
 *
 * @constructor
 * @struct
 * @implements {shaka.util.IDestroyable}
 */
shaka.media.DrmEngine = function(playerInterface) {
  /** @private {?shaka.media.DrmEngine.PlayerInterface} */
  this.playerInterface_ = playerInterface;

  /** @private {Array.<string>} */
  this.supportedTypes_ = null;

  /** @private {MediaKeys} */
  this.mediaKeys_ = null;

  /** @private {HTMLMediaElement} */
  this.video_ = null;

  /** @private {boolean} */
  this.initialized_ = false;

  /** @private {?shaka.extern.DrmInfo} */
  this.currentDrmInfo_ = null;

  /** @private {shaka.util.EventManager} */
  this.eventManager_ = new shaka.util.EventManager();

  /** @private {!Array.<shaka.media.DrmEngine.ActiveSession>} */
  this.activeSessions_ = [];

  /** @private {!Array.<string>} */
  this.offlineSessionIds_ = [];

  /** @private {!shaka.util.PublicPromise} */
  this.allSessionsLoaded_ = new shaka.util.PublicPromise();

  /** @private {?shaka.extern.DrmConfiguration} */
  this.config_ = null;

  /** @private {?function(!shaka.util.Error)} */
  this.onError_ = (err) => {
    this.allSessionsLoaded_.reject(err);
    playerInterface.onError(err);
  };

  /**
   * The most recent key status information we have.
   * We may not have announced this information to the outside world yet,
   * which we delay to batch up changes and avoid spurious "missing key" errors.
   * @private {!Object.<string, string>}
   */
  this.keyStatusByKeyId_ = {};

  /**
   * The key statuses most recently announced to other classes.
   * We may have more up-to-date information being collected in
   * this.keyStatusByKeyId_, which has not been batched up and released yet.
   * @private {!Object.<string, string>}
   */
  this.announcedKeyStatusByKeyId_ = {};

  /** @private {shaka.util.Timer} */
  this.keyStatusTimer_ =
      new shaka.util.Timer(() => this.processKeyStatusChanges_());

  /** @private {boolean} */
  this.destroyed_ = false;

  /** @private {boolean} */
  this.usePersistentLicenses_ = false;

  /** @private {!Array.<!MediaKeyMessageEvent>} */
  this.mediaKeyMessageEvents_ = [];

  /** @private {boolean} */
  this.initialRequestsSent_ = false;

  /** @private {?shaka.util.Timer} */
  this.expirationTimer_
      = new shaka.util.Timer(() => this.pollExpiration_());
  this.expirationTimer_.scheduleRepeated(1);

  // Add a catch to the Promise to avoid console logs about uncaught errors.
  const noop = () => {};
  this.allSessionsLoaded_.catch(noop);
};


/**
 * @typedef {{
 *   loaded: boolean,
 *   initData: Uint8Array,
 *   session: !MediaKeySession,
 *   oldExpiration: number,
 *   updatePromise: shaka.util.PublicPromise
 * }}
 *
 * @description A record to track sessions and suppress duplicate init data.
 * @property {boolean} loaded
 *   True once the key status has been updated (to a non-pending state).  This
 *   does not mean the session is 'usable'.
 * @property {Uint8Array} initData
 *   The init data used to create the session.
 * @property {!MediaKeySession} session
 *   The session object.
 * @property {number} oldExpiration
 *   The expiration of the session on the last check.  This is used to fire
 *   an event when it changes.
 * @property {shaka.util.PublicPromise} updatePromise
 *   An optional Promise that will be resolved/rejected on the next update()
 *   call.  This is used to track the 'license-release' message when calling
 *   remove().
 */
shaka.media.DrmEngine.ActiveSession;


/**
 * @typedef {{
 *   netEngine: !shaka.net.NetworkingEngine,
 *   onError: function(!shaka.util.Error),
 *   onKeyStatus: function(!Object.<string,string>),
 *   onExpirationUpdated: function(string,number),
 *   onEvent: function(!Event)
 * }}
 *
 * @property {shaka.net.NetworkingEngine} netEngine
 *   The NetworkingEngine instance to use.  The caller retains ownership.
 * @property {function(!shaka.util.Error)} onError
 *   Called when an error occurs.  If the error is recoverable (see
 *   {@link shaka.util.Error}) then the caller may invoke either
 *   StreamingEngine.switch*() or StreamingEngine.seeked() to attempt recovery.
 * @property {function(!Object.<string,string>)} onKeyStatus
 *   Called when key status changes.  The argument is a map of hex key IDs to
 *   statuses.
 * @property {function(string,number)} onExpirationUpdated
 *   Called when the session expiration value changes.
 * @property {function(!Event)} onEvent
 *   Called when an event occurs that should be sent to the app.
 */
shaka.media.DrmEngine.PlayerInterface;


/** @override */
shaka.media.DrmEngine.prototype.destroy = function() {
  const Functional = shaka.util.Functional;
  this.destroyed_ = true;

  let async = [];

  // Wait for sessions to close when destroying.
  this.activeSessions_.forEach(function(activeSession) {
    // Ignore any errors when closing the sessions.  One such error would be
    // an invalid state error triggered by closing a session which has not
    // generated any key requests.
    let close = activeSession.session.close().catch(Functional.noop);
    // Due to a bug in Chrome, sometimes the Promise returned by close()
    // never resolves.  See issue #1093 and https://crbug.com/690583.
    let closeTimeout = shaka.media.DrmEngine.timeout_(
        shaka.media.DrmEngine.CLOSE_TIMEOUT_);
    async.push(Promise.race([close, closeTimeout]));
  });
  this.allSessionsLoaded_.reject();

  if (this.eventManager_) {
    async.push(this.eventManager_.destroy());
  }

  if (this.video_) {
    goog.asserts.assert(!this.video_.src, 'video src must be removed first!');
    async.push(this.video_.setMediaKeys(null).catch(Functional.noop));
  }

  if (this.expirationTimer_) {
    this.expirationTimer_.cancel();
    this.expirationTimer_ = null;
  }

  if (this.keyStatusTimer_) {
    this.keyStatusTimer_.cancel();
    this.keyStatusTimer_ = null;
  }

  this.currentDrmInfo_ = null;
  this.supportedTypes_ = null;
  this.mediaKeys_ = null;
  this.video_ = null;
  this.eventManager_ = null;
  this.activeSessions_ = [];
  this.offlineSessionIds_ = [];
  this.config_ = null;
  this.onError_ = null;
  this.playerInterface_ = null;

  return Promise.all(async);
};


/**
 * Called by the Player to provide an updated configuration any time it changes.
 * Must be called at least once before init().
 *
 * @param {shaka.extern.DrmConfiguration} config
 */
shaka.media.DrmEngine.prototype.configure = function(config) {
  this.config_ = config;
};


/**
 * Initialize the drm engine for storing and deleting stored content.
 *
 * @param {!Array.<shaka.extern.Variant>} variants
 *    The variants that are going to be stored.
 * @param {boolean} usePersistentLicenses
 *    Whether or not persistent licenses should be requested and stored for
 *    |manifest|.
 * @return {!Promise}
 */
shaka.media.DrmEngine.prototype.initForStorage = function(
    variants, usePersistentLicenses) {
  // There are two cases for this call:
  //  1. We are about to store a manifest - in that case, there are no offline
  //     sessions and therefore no offline session ids.
  //  2. We are about to remove the offline sessions for this manifest - in
  //     that case, we don't need to know about them right now either as
  //     we will be told which ones to remove later.
  this.offlineSessionIds_ = [];

  // What we really need to know is whether or not they are expecting to use
  // persistent licenses.
  this.usePersistentLicenses_ = usePersistentLicenses;

  return this.init_(variants);
};


/**
 * Initialize the drm engine for playback operations.
 *
 * @param {!Array.<shaka.extern.Variant>} variants
 *    The variants that we want to support playing.
 * @param {!Array.<string>} offlineSessionIds
 * @return {!Promise}
 */
shaka.media.DrmEngine.prototype.initForPlayback = function(
    variants, offlineSessionIds) {
  this.offlineSessionIds_ = offlineSessionIds;
  this.usePersistentLicenses_ = offlineSessionIds.length > 0;

  return this.init_(variants);
};


/**
 * Negotiate for a key system and set up MediaKeys.
 * This will assume that both |usePersistentLicences_| and |offlineSessionIds_|
 * have been properly set.
 *
 * @param {!Array.<shaka.extern.Variant>} variants
 *    The variants that we expect to operate with during the drm engine's
 *    lifespan of the drm engine.
 * @return {!Promise} Resolved if/when a key system has been chosen.
 * @private
 */
shaka.media.DrmEngine.prototype.init_ = function(variants) {
  goog.asserts.assert(this.config_,
      'DrmEngine configure() must be called before init()!');

  const hadDrmInfo = variants.some((v) => v.drmInfos.length > 0);

  // When preparing to play live streams, it is possible that we won't know
  // about some upcoming encrypted content. If we initialize the drm engine
  // with no key systems, we won't be able to play when the encrypted content
  // comes.
  //
  // To avoid this, we will set the drm engine up to work with as many key
  // systems as possible so that we will be ready.
  if (!hadDrmInfo) {
    shaka.media.DrmEngine.replaceDrmInfo_(variants, this.config_.servers);
  }

  // ClearKey config overrides the manifest DrmInfo if present. The variants
  // are modified so that filtering in Player still works.
  /** @type {?shaka.extern.DrmInfo} */
  const clearKeyDrmInfo = this.configureClearKey_();
  if (clearKeyDrmInfo) {
    for (const variant of variants) {
      variant.drmInfos = [clearKeyDrmInfo];
    }
  }

  /** @type {!Object.<string, MediaKeySystemConfiguration>} */
  let configsByKeySystem = {};

  /** @type {!Array.<string>} */
  let keySystemsInOrder = [];

  for (const variant of variants) {
    this.prepareMediaKeyConfigsForVariant_(
        variant, configsByKeySystem, keySystemsInOrder);
  }

  // TODO(vaage): Find an explanation for the difference between this
  //  "unencrypted" form and the "no drm info unencrypted form" and express
  //  that difference here.
  if (!keySystemsInOrder.length) {
    // Unencrypted.
    this.initialized_ = true;
    return Promise.resolve();
  }

  const p = this.queryMediaKeys_(configsByKeySystem, keySystemsInOrder);

  // TODO(vaage): Look into the assertion below. If we do not have any drm info,
  //  we create drm info so that content can play if it has drm info later.
  //  However it is okay if we fail to initialize? If we fail to initialize, it
  //  means we won't be able to play the later-encrypted content, which is no
  //  okay.

  // If the content did not originally have any drm info, then it doesn't matter
  // if we fail to initialize the drm engine, because we won't need it anyway.
  return hadDrmInfo ?
         p :
         p.catch(() => {});
};


/**
 * Attach MediaKeys to the video element and start processing events.
 * @param {HTMLMediaElement} video
 * @return {!Promise}
 */
shaka.media.DrmEngine.prototype.attach = function(video) {
  if (!this.mediaKeys_) {
    // Unencrypted, or so we think.  We listen for encrypted events in order to
    // warn when the stream is encrypted, even though the manifest does not know
    // it.
    // Don't complain about this twice, so just listenOnce().
    this.eventManager_.listenOnce(video, 'encrypted', (event) => {
      this.onError_(new shaka.util.Error(
          shaka.util.Error.Severity.CRITICAL,
          shaka.util.Error.Category.DRM,
          shaka.util.Error.Code.ENCRYPTED_CONTENT_WITHOUT_DRM_INFO));
    });
    return Promise.resolve();
  }

  this.video_ = video;

  this.eventManager_.listenOnce(this.video_, 'play', () => this.onPlay_());

  let setMediaKeys = this.video_.setMediaKeys(this.mediaKeys_);
  setMediaKeys = setMediaKeys.catch(function(exception) {
    return Promise.reject(new shaka.util.Error(
        shaka.util.Error.Severity.CRITICAL,
        shaka.util.Error.Category.DRM,
        shaka.util.Error.Code.FAILED_TO_ATTACH_TO_VIDEO,
        exception.message));
  });

  let setServerCertificate = null;
  if (this.currentDrmInfo_.serverCertificate &&
      this.currentDrmInfo_.serverCertificate.length) {
    setServerCertificate = this.mediaKeys_.setServerCertificate(
        this.currentDrmInfo_.serverCertificate).then(function(supported) {
      if (!supported) {
        shaka.log.warning('Server certificates are not supported by the key' +
                          ' system.  The server certificate has been ignored.');
      }
    }).catch(function(exception) {
      return Promise.reject(new shaka.util.Error(
          shaka.util.Error.Severity.CRITICAL,
          shaka.util.Error.Category.DRM,
          shaka.util.Error.Code.INVALID_SERVER_CERTIFICATE,
          exception.message));
    });
  }

  return Promise.all([setMediaKeys, setServerCertificate]).then(() => {
    if (this.destroyed_) return Promise.reject();

    this.createOrLoad();
    if (!this.currentDrmInfo_.initData.length &&
        !this.offlineSessionIds_.length) {
      // Explicit init data for any one stream or an offline session is
      // sufficient to suppress 'encrypted' events for all streams.
      this.eventManager_.listen(
          this.video_,
          'encrypted',
          (e) => this.onEncrypted_(/** @type {!MediaEncryptedEvent} */ (e)));
    }
  }).catch((error) => {
    if (this.destroyed_) return Promise.resolve();  // Ignore destruction errors
    return Promise.reject(error);
  });
};


/**
 * Remove all given offline sessions and delete their data. This can only be
 * called after a successful call to |init|. This will wait until the
 * 'license-release' message is handled for each license. The returned Promise
 * will be rejected if there is an error releasing any of the licenses.
 *
 * @param {!Array.<string>} sessions
 * @return {!Promise}
 */
shaka.media.DrmEngine.prototype.removeSessions = function(sessions) {
  return Promise.all(sessions.map((id) => this.removeSession(id)));
};


/**
 * Remove an offline session and delete it's data. This can only be called
 * after a successful call to |init|. This will wait until the 'license-release'
 * message is handled. The returned Promise will be rejected if there is an
 * error releasing the license.
 *
 * @param {string} sessionId
 * @return {!Promise}
 */
shaka.media.DrmEngine.prototype.removeSession = async function(sessionId) {
  goog.asserts.assert(this.mediaKeys_, 'Must call init() before removeSession');

  let session = await this.loadOfflineSession_(sessionId);

  // This will be null on error, such as session not found.
  if (!session) {
    return;
  }

  /** @type {!Array.<!Promise>} */
  let tasks = [];

  // TODO: Consider adding a timeout to get the 'message' event.
  // Note that the 'message' event will get raised after the remove()
  // promise resolves.

  let active = this.activeSessions_.filter((s) => s.session == session);
  goog.asserts.assert(
      active.length <= 1,
      'There should be no more than one active session matching ' + sessionId);

  active.forEach((activeSession) => {
    let update = new shaka.util.PublicPromise();
    tasks.push(update);
    activeSession.updatePromise = update;
  });

  tasks.push(session.remove());

  return Promise.all(tasks);
};

/**
 * Creates the sessions for the init data and waits for them to become ready.
 *
 * @return {!Promise}
 */
shaka.media.DrmEngine.prototype.createOrLoad = function() {
  // Create temp sessions.
  let initDatas = this.currentDrmInfo_ ? this.currentDrmInfo_.initData : [];
  initDatas.forEach((initDataOverride) => {
    return this.createTemporarySession_(initDataOverride.initDataType,
                                        initDataOverride.initData);
  });

  // Load each session.
  this.offlineSessionIds_.forEach((sessionId) => {
    return this.loadOfflineSession_(sessionId);
  });

  // If we have no sessions, we need to resolve the promise right now or else
  // it will never get resolved.
  if (!initDatas.length && !this.offlineSessionIds_.length) {
    this.allSessionsLoaded_.resolve();
  }

  return this.allSessionsLoaded_;
};


/** @return {boolean} */
shaka.media.DrmEngine.prototype.initialized = function() {
  return this.initialized_;
};


/** @return {string} */
shaka.media.DrmEngine.prototype.keySystem = function() {
  return this.currentDrmInfo_ ? this.currentDrmInfo_.keySystem : '';
};


/**
 * Returns an array of the media types supported by the current key system.
 * These will be full mime types (e.g. 'video/webm; codecs="vp8"').
 *
 * @return {Array.<string>}
 */
shaka.media.DrmEngine.prototype.getSupportedTypes = function() {
  return this.supportedTypes_;
};


/**
 * Returns the ID of the sessions currently active.
 *
 * @return {!Array.<string>}
 */
shaka.media.DrmEngine.prototype.getSessionIds = function() {
  return this.activeSessions_.map(function(session) {
    return session.session.sessionId;
  });
};


/**
 * Returns the next expiration time, or Infinity.
 * @return {number}
 */
shaka.media.DrmEngine.prototype.getExpiration = function() {
  let expirations = this.activeSessions_.map(function(session) {
    let expiration = session.session.expiration;
    return isNaN(expiration) ? Infinity : expiration;
  });
  // This will equal Infinity if there are no entries.
  return Math.min.apply(Math, expirations);
};


/**
 * Returns the DrmInfo that was used to initialize the current key system.
 *
 * @return {?shaka.extern.DrmInfo}
 */
shaka.media.DrmEngine.prototype.getDrmInfo = function() {
  return this.currentDrmInfo_;
};


/**
 * Returns the current key statuses.
 *
 * @return {!Object.<string, string>}
 */
shaka.media.DrmEngine.prototype.getKeyStatuses = function() {
  return this.announcedKeyStatusByKeyId_;
};


/**
 * @param {!shaka.extern.Variant} variant
 * @param {!Object.<string, MediaKeySystemConfiguration>} configsByKeySystem
 *   (Output parameter.)  A dictionary of configs, indexed by key system.
 * @param {!Array.<string>} keySystemsInOrder
 *   (Output parameter.)  A list of key systems in the order in which we
 *   encounter them.
 * @see https://bit.ly/EmeConfig for MediaKeySystemConfiguration spec
 * @private
 */
shaka.media.DrmEngine.prototype.prepareMediaKeyConfigsForVariant_ =
    function(variant, configsByKeySystem, keySystemsInOrder) {
  // Get all the streams in the variant.
  const streams = shaka.util.StreamUtils.getVariantStreams(variant);

  // Make sure all the drm infos are valid and filled in correctly.
  variant.drmInfos.forEach((info) => {
    this.fillInDrmInfoDefaults_(info);

    // Chromecast has a variant of PlayReady that uses a different key
    // system ID.  Since manifest parsers convert the standard PlayReady
    // UUID to the standard PlayReady key system ID, here we will switch
    // to the Chromecast version if we are running on that platform.
    // Note that this must come after fillInDrmInfoDefaults_, since the
    // player config uses the standard PlayReady ID for license server
    // configuration.
    if (window.cast && window.cast.__platform__) {
      if (info.keySystem == 'com.microsoft.playready') {
        info.keySystem = 'com.chromecast.playready';
      }
    }
  });

  // Fill in any missing config entries.
  variant.drmInfos.forEach((info) => {
    if (configsByKeySystem[info.keySystem]) {
      return;
    }

    const persistentState =
        this.usePersistentLicenses_ ? 'required' : 'optional';
    const sessionTypes =
        this.usePersistentLicenses_ ? ['persistent-license'] : ['temporary'];

    const config = {
      // Ignore initDataTypes.
      audioCapabilities: [],
      videoCapabilities: [],
      distinctiveIdentifier: 'optional',
      persistentState: persistentState,
      sessionTypes: sessionTypes,
      label: info.keySystem,
      drmInfos: [],  // Tracked by us, ignored by EME.
    };

    configsByKeySystem[info.keySystem] = config;
    keySystemsInOrder.push(info.keySystem);
  });

  // Add the last bit of information to each config;
  variant.drmInfos.forEach((info) => {
    let config = configsByKeySystem[info.keySystem];
    goog.asserts.assert(
        config,
        'Any missing configs should have be filled in before.');

    config.drmInfos.push(info);

    if (info.distinctiveIdentifierRequired) {
      config.distinctiveIdentifier = 'required';
    }

    if (info.persistentStateRequired) {
      config.persistentState = 'required';
    }

    streams.forEach((stream) => {
      const ContentType = shaka.util.ManifestParserUtils.ContentType;
      let isVideo = stream.type == ContentType.VIDEO;

      /** @type {?string} */
      let robustness = isVideo ?
                       info.videoRobustness :
                       info.audioRobustness;

      /** @type {string} */
      let fullMimeType = shaka.util.MimeUtils.getFullType(
          stream.mimeType, stream.codecs);

      /** @type {MediaKeySystemMediaCapability} */
      let capability = {
        robustness: robustness || '',
        contentType: fullMimeType,
      };

      if (isVideo) {
        config.videoCapabilities.push(capability);
      } else {
        config.audioCapabilities.push(capability);
      }
    });
  });
};


/**
 * @param {!Object.<string, MediaKeySystemConfiguration>} configsByKeySystem
 *   A dictionary of configs, indexed by key system.
 * @param {!Array.<string>} keySystemsInOrder
 *   A list of key systems in the order in which we should query them.
 *   On a browser which supports multiple key systems, the order may indicate
 *   a real preference for the application.
 * @return {!Promise} Resolved if/when a key system has been chosen.
 * @private
 */
shaka.media.DrmEngine.prototype.queryMediaKeys_ = function(
    configsByKeySystem, keySystemsInOrder) {
  if (keySystemsInOrder.length == 1 && keySystemsInOrder[0] == '') {
    return Promise.reject(new shaka.util.Error(
        shaka.util.Error.Severity.CRITICAL,
        shaka.util.Error.Category.DRM,
        shaka.util.Error.Code.NO_RECOGNIZED_KEY_SYSTEMS));
  }

  // Wait to reject this initial Promise until we have built the entire chain.
  let instigator = new shaka.util.PublicPromise();
  let p = instigator;

  // Try key systems with configured license servers first.  We only have to try
  // key systems without configured license servers for diagnostic reasons, so
  // that we can differentiate between "none of these key systems are available"
  // and "some are available, but you did not configure them properly."  The
  // former takes precedence.
  [true, false].forEach(function(shouldHaveLicenseServer) {
    keySystemsInOrder.forEach(function(keySystem) {
      let config = configsByKeySystem[keySystem];

      let hasLicenseServer = config.drmInfos.some(function(info) {
        return !!info.licenseServerUri;
      });
      if (hasLicenseServer != shouldHaveLicenseServer) return;

      // If there are no tracks of a type, these should be not present.
      // Otherwise the query will fail.
      if (config.audioCapabilities.length == 0) {
        delete config.audioCapabilities;
      }
      if (config.videoCapabilities.length == 0) {
        delete config.videoCapabilities;
      }

      p = p.catch(function() {
        if (this.destroyed_) return Promise.reject();
        return navigator.requestMediaKeySystemAccess(keySystem, [config]);
      }.bind(this));
    }.bind(this));
  }.bind(this));

  p = p.catch(() => {
    return Promise.reject(new shaka.util.Error(
        shaka.util.Error.Severity.CRITICAL,
        shaka.util.Error.Category.DRM,
        shaka.util.Error.Code.REQUESTED_KEY_SYSTEM_CONFIG_UNAVAILABLE));
  });

  p = p.then(function(mediaKeySystemAccess) {
    if (this.destroyed_) return Promise.reject();

    // TODO: Remove once Edge has released a fix for https://bit.ly/2IcEgv0
    let isEdge = navigator.userAgent.indexOf('Edge/') >= 0;

    // Store the capabilities of the key system.
    let realConfig = mediaKeySystemAccess.getConfiguration();
    let audioCaps = realConfig.audioCapabilities || [];
    let videoCaps = realConfig.videoCapabilities || [];

    // Get the set of supported content types from the audio and video
    // capabilities. Remove the duplicates so that it is easier to read
    // what is supported.
    const supportedTypes = [];
    for (const cap of audioCaps) {
      supportedTypes.push(cap.contentType);
    }
    for (const cap of videoCaps) {
      supportedTypes.push(cap.contentType);
    }
    this.supportedTypes_ = shaka.util.ArrayUtils.removeDuplicates(
        supportedTypes);

    if (isEdge) {
      // Edge 14 does not report correct capabilities.  It will only report the
      // first MIME type even if the others are supported.  To work around this,
      // set the supported types to null, which Player will use as a signal that
      // the information is not available.
      // See: https://bit.ly/2IcEgv0
      this.supportedTypes_ = null;
    }
    goog.asserts.assert(!this.supportedTypes_ || this.supportedTypes_.length,
                        'We should get at least one supported MIME type');

    let originalConfig = configsByKeySystem[mediaKeySystemAccess.keySystem];
    this.createCurrentDrmInfo_(
        mediaKeySystemAccess.keySystem, originalConfig,
        originalConfig.drmInfos);

    if (!this.currentDrmInfo_.licenseServerUri) {
      return Promise.reject(new shaka.util.Error(
          shaka.util.Error.Severity.CRITICAL,
          shaka.util.Error.Category.DRM,
          shaka.util.Error.Code.NO_LICENSE_SERVER_GIVEN));
    }

    return mediaKeySystemAccess.createMediaKeys();
  }.bind(this)).then(function(mediaKeys) {
    if (this.destroyed_) return Promise.reject();

    this.mediaKeys_ = mediaKeys;
    this.initialized_ = true;
  }.bind(this)).catch(function(exception) {
    if (this.destroyed_) return Promise.resolve();  // Ignore destruction errors

    // Don't rewrap a shaka.util.Error from earlier in the chain:
    this.currentDrmInfo_ = null;
    this.supportedTypes_ = null;
    if (exception instanceof shaka.util.Error) {
      return Promise.reject(exception);
    }

    // We failed to create MediaKeys.  This generally shouldn't happen.
    return Promise.reject(new shaka.util.Error(
        shaka.util.Error.Severity.CRITICAL,
        shaka.util.Error.Category.DRM,
        shaka.util.Error.Code.FAILED_TO_CREATE_CDM,
        exception.message));
  }.bind(this));

  instigator.reject();
  return p;
};


/**
 * Use this.config_ to fill in missing values in drmInfo.
 * @param {shaka.extern.DrmInfo} drmInfo
 * @private
 */
shaka.media.DrmEngine.prototype.fillInDrmInfoDefaults_ = function(drmInfo) {
  let keySystem = drmInfo.keySystem;

  if (!keySystem) {
    // This is a placeholder from the manifest parser for an unrecognized key
    // system.  Skip this entry, to avoid logging nonsensical errors.
    return;
  }

  if (!drmInfo.licenseServerUri) {
    let server = this.config_.servers[keySystem];
    if (server) {
      drmInfo.licenseServerUri = server;
    }
  }

  if (!drmInfo.keyIds) {
    drmInfo.keyIds = [];
  }

  let advanced = this.config_.advanced[keySystem];
  if (advanced) {
    if (!drmInfo.distinctiveIdentifierRequired) {
      drmInfo.distinctiveIdentifierRequired =
          advanced.distinctiveIdentifierRequired;
    }

    if (!drmInfo.persistentStateRequired) {
      drmInfo.persistentStateRequired = advanced.persistentStateRequired;
    }

    if (!drmInfo.videoRobustness) {
      drmInfo.videoRobustness = advanced.videoRobustness;
    }

    if (!drmInfo.audioRobustness) {
      drmInfo.audioRobustness = advanced.audioRobustness;
    }

    if (!drmInfo.serverCertificate) {
      drmInfo.serverCertificate = advanced.serverCertificate;
    }
  }
};


/**
 * Create a DrmInfo using configured clear keys.
 * The server URI will be a data URI which decodes to a clearkey license.
 * @return {?shaka.extern.DrmInfo} or null if clear keys are not configured.
 * @private
 * @see https://bit.ly/2K8gOnv for the spec on the clearkey license format.
 */
shaka.media.DrmEngine.prototype.configureClearKey_ = function() {
  const clearKeys = shaka.util.MapUtils.asMap(this.config_.clearKeys);
  if (clearKeys.size == 0) { return null; }

  const StringUtils = shaka.util.StringUtils;
  const Uint8ArrayUtils = shaka.util.Uint8ArrayUtils;
  let keys = [];
  let keyIds = [];

  clearKeys.forEach((keyHex, keyIdHex) => {
    let keyId = Uint8ArrayUtils.fromHex(keyIdHex);
    let key = Uint8ArrayUtils.fromHex(keyHex);
    let keyObj = {
      kty: 'oct',
      kid: Uint8ArrayUtils.toBase64(keyId, false),
      k: Uint8ArrayUtils.toBase64(key, false),
    };

    keys.push(keyObj);
    keyIds.push(keyObj.kid);
  });

  let jwkSet = {keys: keys};
  let license = JSON.stringify(jwkSet);

  // Use the keyids init data since is suggested by EME.
  // Suggestion: https://bit.ly/2JYcNTu
  // Format: https://www.w3.org/TR/eme-initdata-keyids/
  let initDataStr = JSON.stringify({'kids': keyIds});
  let initData = new Uint8Array(StringUtils.toUTF8(initDataStr));
  let initDatas = [{initData: initData, initDataType: 'keyids'}];

  return {
    keySystem: 'org.w3.clearkey',
    licenseServerUri: 'data:application/json;base64,' + window.btoa(license),
    distinctiveIdentifierRequired: false,
    persistentStateRequired: false,
    audioRobustness: '',
    videoRobustness: '',
    serverCertificate: null,
    initData: initDatas,
    keyIds: [],
  };
};


/**
 * Creates a DrmInfo object describing the settings used to initialize the
 * engine.
 *
 * @param {string} keySystem
 * @param {MediaKeySystemConfiguration} config
 * @param {!Array.<shaka.extern.DrmInfo>} drmInfos
 * @private
 */
shaka.media.DrmEngine.prototype.createCurrentDrmInfo_ = function(
    keySystem, config, drmInfos) {
  /** @type {!Array.<string>} */
  let licenseServers = [];

  /** @type {!Array.<!Uint8Array>} */
  let serverCerts = [];

  /** @type {!Array.<!shaka.extern.InitDataOverride>} */
  let initDatas = [];

  /** @type {!Array.<string>} */
  let keyIds = [];

  this.processDrmInfos_(drmInfos, licenseServers, serverCerts, initDatas,
      keyIds);

  if (serverCerts.length > 1) {
    shaka.log.warning('Multiple unique server certificates found! ' +
                      'Only the first will be used.');
  }

  if (licenseServers.length > 1) {
    shaka.log.warning('Multiple unique license server URIs found! ' +
                      'Only the first will be used.');
  }

  // TODO: This only works when all DrmInfo have the same robustness.
  let audioRobustness =
      config.audioCapabilities ? config.audioCapabilities[0].robustness : '';
  let videoRobustness =
      config.videoCapabilities ? config.videoCapabilities[0].robustness : '';
  this.currentDrmInfo_ = {
    keySystem: keySystem,
    licenseServerUri: licenseServers[0],
    distinctiveIdentifierRequired: (config.distinctiveIdentifier == 'required'),
    persistentStateRequired: (config.persistentState == 'required'),
    audioRobustness: audioRobustness,
    videoRobustness: videoRobustness,
    serverCertificate: serverCerts[0],
    initData: initDatas,
    keyIds: keyIds,
  };
};


/**
 * Extract license server, server cert, and init data from DrmInfos, taking
 * care to eliminate duplicates.
 *
 * @param {!Array.<shaka.extern.DrmInfo>} drmInfos
 * @param {!Array.<string>} licenseServers
 * @param {!Array.<!Uint8Array>} serverCerts
 * @param {!Array.<!shaka.extern.InitDataOverride>} initDatas
 * @param {!Array.<string>} keyIds
 * @private
 */
shaka.media.DrmEngine.prototype.processDrmInfos_ =
    function(drmInfos, licenseServers, serverCerts, initDatas, keyIds) {
  /** @type {function(shaka.extern.InitDataOverride,
   *                  shaka.extern.InitDataOverride):boolean} */
  let initDataOverrideEqual = (a, b) => {
    if (a.keyId && a.keyId == b.keyId) {
      // Two initDatas with the same keyId are considered to be the same,
      // unless that "same keyId" is null.
      return true;
    }
    return a.initDataType == b.initDataType &&
           shaka.util.Uint8ArrayUtils.equal(a.initData, b.initData);
  };

  drmInfos.forEach((drmInfo) => {
    // Aliases:
    const ArrayUtils = shaka.util.ArrayUtils;
    const Uint8ArrayUtils = shaka.util.Uint8ArrayUtils;

    // Build an array of unique license servers.
    if (licenseServers.indexOf(drmInfo.licenseServerUri) == -1) {
      licenseServers.push(drmInfo.licenseServerUri);
    }

    // Build an array of unique server certs.
    if (drmInfo.serverCertificate) {
      if (ArrayUtils.indexOf(serverCerts, drmInfo.serverCertificate,
                             Uint8ArrayUtils.equal) == -1) {
        serverCerts.push(drmInfo.serverCertificate);
      }
    }

    // Build an array of unique init datas.
    if (drmInfo.initData) {
      drmInfo.initData.forEach((initDataOverride) => {
        if (ArrayUtils.indexOf(initDatas, initDataOverride,
                               initDataOverrideEqual) == -1) {
          initDatas.push(initDataOverride);
        }
      });
    }

    if (drmInfo.keyIds) {
      for (let i = 0; i < drmInfo.keyIds.length; ++i) {
        if (keyIds.indexOf(drmInfo.keyIds[i]) == -1) {
          keyIds.push(drmInfo.keyIds[i]);
        }
      }
    }
  });
};


/**
 * @param {!MediaEncryptedEvent} event
 * @private
 */
shaka.media.DrmEngine.prototype.onEncrypted_ = function(event) {
  // Aliases:
  const Uint8ArrayUtils = shaka.util.Uint8ArrayUtils;

  let initData = new Uint8Array(event.initData);

  // Suppress duplicate init data.
  // Note that some init data are extremely large and can't portably be used as
  // keys in a dictionary.
  for (let i = 0; i < this.activeSessions_.length; ++i) {
    if (Uint8ArrayUtils.equal(initData, this.activeSessions_[i].initData)) {
      shaka.log.debug('Ignoring duplicate init data.');
      return;
    }
  }

  this.createTemporarySession_(event.initDataType, initData);
};


/**
 * @param {string} sessionId
 * @return {!Promise.<MediaKeySession>}
 * @private
 */
shaka.media.DrmEngine.prototype.loadOfflineSession_ = function(sessionId) {
  let session;
  try {
    session = this.mediaKeys_.createSession('persistent-license');
  } catch (exception) {
    let error = new shaka.util.Error(
        shaka.util.Error.Severity.CRITICAL,
        shaka.util.Error.Category.DRM,
        shaka.util.Error.Code.FAILED_TO_CREATE_SESSION,
        exception.message);
    this.onError_(error);
    return Promise.reject(error);
  }

  this.eventManager_.listen(session, 'message',
      /** @type {shaka.util.EventManager.ListenerType} */(
          this.onSessionMessage_.bind(this)));
  this.eventManager_.listen(session, 'keystatuseschange',
      this.onKeyStatusesChange_.bind(this));

  let activeSession = {
    initData: null,
    session: session,
    loaded: false,
    oldExpiration: Infinity,
    updatePromise: null,
  };
  this.activeSessions_.push(activeSession);

  return session.load(sessionId).then(function(present) {
    if (this.destroyed_) return;

    if (!present) {
      let i = this.activeSessions_.indexOf(activeSession);
      goog.asserts.assert(i >= 0, 'Session must be in the array');
      this.activeSessions_.splice(i, 1);

      this.onError_(new shaka.util.Error(
          shaka.util.Error.Severity.CRITICAL,
          shaka.util.Error.Category.DRM,
          shaka.util.Error.Code.OFFLINE_SESSION_REMOVED));
      return;
    }

    // TODO: We should get a key status change event.  Remove once Chrome CDM
    // is fixed.
    activeSession.loaded = true;
    if (this.activeSessions_.every((s) => s.loaded)) {
      this.allSessionsLoaded_.resolve();
    }

    return session;
  }.bind(this), function(error) {
    if (this.destroyed_) return;

    let i = this.activeSessions_.indexOf(activeSession);
    goog.asserts.assert(i >= 0, 'Session must be in the array');
    this.activeSessions_.splice(i, 1);

    this.onError_(new shaka.util.Error(
        shaka.util.Error.Severity.CRITICAL,
        shaka.util.Error.Category.DRM,
        shaka.util.Error.Code.FAILED_TO_CREATE_SESSION,
        error.message));
  }.bind(this));
};


/**
 * @param {string} initDataType
 * @param {!Uint8Array} initData
 * @private
 */
shaka.media.DrmEngine.prototype.createTemporarySession_ =
    function(initDataType, initData) {
  let session;
  try {
    if (this.usePersistentLicenses_) {
      session = this.mediaKeys_.createSession('persistent-license');
    } else {
      session = this.mediaKeys_.createSession();
    }
  } catch (exception) {
    this.onError_(new shaka.util.Error(
        shaka.util.Error.Severity.CRITICAL,
        shaka.util.Error.Category.DRM,
        shaka.util.Error.Code.FAILED_TO_CREATE_SESSION,
        exception.message));
    return;
  }

  this.eventManager_.listen(session, 'message',
      /** @type {shaka.util.EventManager.ListenerType} */(
          this.onSessionMessage_.bind(this)));
  this.eventManager_.listen(session, 'keystatuseschange',
      this.onKeyStatusesChange_.bind(this));
  this.activeSessions_.push({
    initData: initData,
    session: session,
    loaded: false,
    oldExpiration: Infinity,
    updatePromise: null,
  });

  session.generateRequest(initDataType, initData.buffer).catch(function(error) {
    if (this.destroyed_) return;

    for (let i = 0; i < this.activeSessions_.length; ++i) {
      if (this.activeSessions_[i].session == session) {
        this.activeSessions_.splice(i, 1);
        break;
      }
    }
    this.onError_(new shaka.util.Error(
        shaka.util.Error.Severity.CRITICAL,
        shaka.util.Error.Category.DRM,
        shaka.util.Error.Code.FAILED_TO_GENERATE_LICENSE_REQUEST,
        error.message));
  }.bind(this));
};


/**
 * @param {!MediaKeyMessageEvent} event
 * @private
 */
shaka.media.DrmEngine.prototype.onSessionMessage_ = function(event) {
  if (this.delayLicenseRequest_()) {
    this.mediaKeyMessageEvents_.push(event);
  } else {
    this.sendLicenseRequest_(event);
  }
};


/**
 * @return {boolean}
 * @private
 */
shaka.media.DrmEngine.prototype.delayLicenseRequest_ = function() {
  return (this.config_.delayLicenseRequestUntilPlayed &&
          this.video_.paused && !this.initialRequestsSent_);
};


/**
 * Sends a license request.
 * @param {!MediaKeyMessageEvent} event
 * @private
 */
shaka.media.DrmEngine.prototype.sendLicenseRequest_ = function(event) {
  /** @type {!MediaKeySession} */
  let session = event.target;

  let activeSession;
  for (let i = 0; i < this.activeSessions_.length; i++) {
    if (this.activeSessions_[i].session == session) {
      activeSession = this.activeSessions_[i];
      break;
    }
  }

  let url = this.currentDrmInfo_.licenseServerUri;
  const advancedConfig = this.config_.advanced[this.currentDrmInfo_.keySystem];
  if (event.messageType == 'individualization-request' && advancedConfig &&
      advancedConfig.individualizationServer) {
    url = advancedConfig.individualizationServer;
  }

  const requestType = shaka.net.NetworkingEngine.RequestType.LICENSE;
  let request = shaka.net.NetworkingEngine.makeRequest(
      [url], this.config_.retryParameters);
  request.body = event.message;
  request.method = 'POST';
  request.licenseRequestType = event.messageType;
  // NOTE: allowCrossSiteCredentials can be set in a request filter.

  if (this.currentDrmInfo_.keySystem == 'com.microsoft.playready' ||
      this.currentDrmInfo_.keySystem == 'com.chromecast.playready') {
    this.unpackPlayReadyRequest_(request);
  }

  this.playerInterface_.netEngine.request(requestType, request).promise
      .then(function(response) {
        if (this.destroyed_) return Promise.reject();

        // Request succeeded, now pass the response to the CDM.
        return session.update(response.data).then(function() {
          let event = new shaka.util.FakeEvent('drmsessionupdate');
          this.playerInterface_.onEvent(event);

          if (activeSession) {
            if (activeSession.updatePromise) {
              activeSession.updatePromise.resolve();
            }
            // In case there are no key statuses, consider this session loaded
            // after a reasonable timeout.  It should definitely not take 5
            // seconds to process a license.
            const loadTimeout = shaka.media.DrmEngine.timeout_(
                shaka.media.DrmEngine.SESSION_LOAD_TIMEOUT_);
            loadTimeout.then(() => {
              activeSession.loaded = true;
              if (this.activeSessions_.every((s) => s.loaded)) {
                this.allSessionsLoaded_.resolve();
              }
            });
          }
        }.bind(this));
      }.bind(this), function(error) {
        // Ignore destruction errors
        if (this.destroyed_) return Promise.resolve();

        // Request failed!
        goog.asserts.assert(error instanceof shaka.util.Error,
                            'Wrong NetworkingEngine error type!');
        let shakaErr = new shaka.util.Error(
            shaka.util.Error.Severity.CRITICAL,
            shaka.util.Error.Category.DRM,
            shaka.util.Error.Code.LICENSE_REQUEST_FAILED,
            error);
        this.onError_(shakaErr);
        if (activeSession && activeSession.updatePromise) {
          activeSession.updatePromise.reject(shakaErr);
        }
      }.bind(this)).catch(function(error) {
        // Ignore destruction errors
        if (this.destroyed_) return Promise.resolve();

        // Session update failed!
        let shakaErr = new shaka.util.Error(
            shaka.util.Error.Severity.CRITICAL,
            shaka.util.Error.Category.DRM,
            shaka.util.Error.Code.LICENSE_RESPONSE_REJECTED,
            error.message);
        this.onError_(shakaErr);
        if (activeSession && activeSession.updatePromise) {
          activeSession.updatePromise.reject(shakaErr);
        }
      }.bind(this));
};


/**
 * Unpacks PlayReady license requests.  Modifies the request object.
 * @param {shaka.extern.Request} request
 * @private
 */
shaka.media.DrmEngine.prototype.unpackPlayReadyRequest_ = function(request) {
  // On IE and Edge, the raw license message is UTF-16-encoded XML.  We need to
  // unpack the Challenge element (base64-encoded string containing the actual
  // license request) and any HttpHeader elements (sent as request headers).

  // Example XML:

  // <PlayReadyKeyMessage type="LicenseAcquisition">
  //   <LicenseAcquisition Version="1">
  //     <Challenge encoding="base64encoded">{Base64Data}</Challenge>
  //     <HttpHeaders>
  //       <HttpHeader>
  //         <name>Content-Type</name>
  //         <value>text/xml; charset=utf-8</value>
  //       </HttpHeader>
  //       <HttpHeader>
  //         <name>SOAPAction</name>
  //         <value>http://schemas.microsoft.com/DRM/etc/etc</value>
  //       </HttpHeader>
  //     </HttpHeaders>
  //   </LicenseAcquisition>
  // </PlayReadyKeyMessage>

  let xml = shaka.util.StringUtils.fromUTF16(
      request.body, true /* littleEndian */, true /* noThrow */);
  if (xml.indexOf('PlayReadyKeyMessage') == -1) {
    // This does not appear to be a wrapped message as on IE and Edge.  Some
    // clients do not need this unwrapping, so we will assume this is one of
    // them.  Note that "xml" at this point probably looks like random garbage,
    // since we interpreted UTF-8 as UTF-16.
    shaka.log.debug('PlayReady request is already unwrapped.');
    request.headers['Content-Type'] = 'text/xml; charset=utf-8';
    return;
  }
  shaka.log.debug('Unwrapping PlayReady request.');
  let dom = new DOMParser().parseFromString(xml, 'application/xml');

  // Set request headers.
  let headers = dom.getElementsByTagName('HttpHeader');
  for (let i = 0; i < headers.length; ++i) {
    let name = headers[i].querySelector('name');
    let value = headers[i].querySelector('value');
    goog.asserts.assert(name && value, 'Malformed PlayReady headers!');
    request.headers[name.textContent] = value.textContent;
  }

  // Unpack the base64-encoded challenge.
  let challenge = dom.querySelector('Challenge');
  goog.asserts.assert(challenge, 'Malformed PlayReady challenge!');
  goog.asserts.assert(challenge.getAttribute('encoding') == 'base64encoded',
                      'Unexpected PlayReady challenge encoding!');
  request.body =
      shaka.util.Uint8ArrayUtils.fromBase64(challenge.textContent).buffer;
};


/**
 * @param {!Event} event
 * @private
 * @suppress {invalidCasts} to swap keyId and status
 */
shaka.media.DrmEngine.prototype.onKeyStatusesChange_ = function(event) {
  let session = /** @type {!MediaKeySession} */(event.target);

  // Locate the session in the active sessions list.
  let i;
  for (i = 0; i < this.activeSessions_.length; ++i) {
    if (this.activeSessions_[i].session == session) {
      break;
    }
  }
  goog.asserts.assert(i < this.activeSessions_.length,
                      'Key status change for inactive session!');
  if (i == this.activeSessions_.length) return;

  let keyStatusMap = session.keyStatuses;
  let hasExpiredKeys = false;

  keyStatusMap.forEach(function(status, keyId) {
    // The spec has changed a few times on the exact order of arguments here.
    // As of 2016-06-30, Edge has the order reversed compared to the current
    // EME spec.  Given the back and forth in the spec, it may not be the only
    // one.  Try to detect this and compensate:
    if (typeof keyId == 'string') {
      let tmp = keyId;
      keyId = /** @type {ArrayBuffer} */(status);
      status = /** @type {string} */(tmp);
    }

    // Microsoft's implementation in Edge seems to present key IDs as
    // little-endian UUIDs, rather than big-endian or just plain array of bytes.
    // standard: 6e 5a 1d 26 - 27 57 - 47 d7 - 80 46 ea a5 d1 d3 4b 5a
    // on Edge:  26 1d 5a 6e - 57 27 - d7 47 - 80 46 ea a5 d1 d3 4b 5a
    // Bug filed: https://bit.ly/2thuzXu

    // NOTE that we skip this if byteLength != 16.  This is used for the IE11
    // and Edge 12 EME polyfill, which uses single-byte dummy key IDs.
    if (this.currentDrmInfo_.keySystem == 'com.microsoft.playready' &&
        keyId.byteLength == 16) {
      // Read out some fields in little-endian:
      let dataView = new DataView(keyId);
      let part0 = dataView.getUint32(0, true /* LE */);
      let part1 = dataView.getUint16(4, true /* LE */);
      let part2 = dataView.getUint16(6, true /* LE */);
      // Write it back in big-endian:
      dataView.setUint32(0, part0, false /* BE */);
      dataView.setUint16(4, part1, false /* BE */);
      dataView.setUint16(6, part2, false /* BE */);
    }

    // Microsoft's implementation in IE11 seems to never set key status to
    // 'usable'.  It is stuck forever at 'status-pending'.  In spite of this,
    // the keys do seem to be usable and content plays correctly.
    // Bug filed: https://bit.ly/2tpIU3n
    // Microsoft has fixed the issue on Edge, but it remains in IE.
    if (this.currentDrmInfo_.keySystem == 'com.microsoft.playready' &&
        status == 'status-pending') {
      status = 'usable';
    }

    if (status != 'status-pending') {
      this.activeSessions_[i].loaded = true;
    }

    if (status == 'expired') {
      hasExpiredKeys = true;
    }

    let keyIdHex = shaka.util.Uint8ArrayUtils.toHex(new Uint8Array(keyId));

    this.keyStatusByKeyId_[keyIdHex] = status;
  }.bind(this));

  // If the session has expired, close it.
  // Some CDMs do not have sub-second time resolution, so the key status may
  // fire with hundreds of milliseconds left until the stated expiration time.
  let msUntilExpiration = session.expiration - Date.now();
  if (msUntilExpiration < 0 || (hasExpiredKeys && msUntilExpiration < 1000)) {
    // If this is part of a remove(), we don't want to close the session until
    // the update is complete.  Otherwise, we will orphan the session.
    if (!this.activeSessions_[i].updatePromise) {
      shaka.log.debug('Session has expired', session);
      this.activeSessions_.splice(i, 1);
      session.close().catch(() => {});  // Silence uncaught rejection errors
    }
  }

  const allSessionsLoaded = this.activeSessions_.every((s) => s.loaded);
  if (!allSessionsLoaded) {
    // Don't announce key statuses or resolve the "all loaded" promise until
    // everything is loaded.
    return;
  }

  this.allSessionsLoaded_.resolve();

  // Batch up key status changes before checking them or notifying Player.
  // This handles cases where the statuses of multiple sessions are set
  // simultaneously by the browser before dispatching key status changes for
  // each of them.  By batching these up, we only send one status change event
  // and at most one EXPIRED error on expiration.
  this.keyStatusTimer_.schedule(shaka.media.DrmEngine.KEY_STATUS_BATCH_TIME_);
};


/**
 * @private
 */
shaka.media.DrmEngine.prototype.processKeyStatusChanges_ = function() {
  // Copy the latest key statuses into the publicly-accessible map.
  this.announcedKeyStatusByKeyId_ = {};
  for (let keyId in this.keyStatusByKeyId_) {
    this.announcedKeyStatusByKeyId_[keyId] = this.keyStatusByKeyId_[keyId];
  }

  // If all keys are expired, fire an error. |every| is always true for an empty
  // array but we shouldn't fire an error for a lack of key status info.
  const statuses = shaka.util.MapUtils.values(this.announcedKeyStatusByKeyId_);
  const allExpired = statuses.length &&
                     statuses.every((status) => status == 'expired');

  if (allExpired) {
    this.onError_(new shaka.util.Error(
        shaka.util.Error.Severity.CRITICAL,
        shaka.util.Error.Category.DRM,
        shaka.util.Error.Code.EXPIRED));
  }

  this.playerInterface_.onKeyStatus(this.announcedKeyStatusByKeyId_);
};


/**
 * Returns true if the browser has recent EME APIs.
 *
 * @return {boolean}
 */
shaka.media.DrmEngine.isBrowserSupported = function() {
  let basic =
      !!window.MediaKeys &&
      !!window.navigator &&
      !!window.navigator.requestMediaKeySystemAccess &&
      !!window.MediaKeySystemAccess &&
      !!window.MediaKeySystemAccess.prototype.getConfiguration;

  return basic;
};


/**
 * Returns a Promise to a map of EME support for well-known key systems.
 *
 * @return {!Promise.<!Object.<string, ?shaka.extern.DrmSupportType>>}
 */
shaka.media.DrmEngine.probeSupport = function() {
  goog.asserts.assert(shaka.media.DrmEngine.isBrowserSupported(),
                      'Must have basic EME support');

  let tests = [];
  let testKeySystems = [
    'org.w3.clearkey',
    'com.widevine.alpha',
    'com.microsoft.playready',
    'com.apple.fps.2_0',
    'com.apple.fps.1_0',
    'com.apple.fps',
    'com.adobe.primetime',
  ];

  let basicVideoCapabilities = [
    {contentType: 'video/mp4; codecs="avc1.42E01E"'},
    {contentType: 'video/webm; codecs="vp8"'},
  ];

  let basicConfig = {
    videoCapabilities: basicVideoCapabilities,
  };
  let offlineConfig = {
    videoCapabilities: basicVideoCapabilities,
    persistentState: 'required',
    sessionTypes: ['persistent-license'],
  };

  // Try the offline config first, then fall back to the basic config.
  let configs = [offlineConfig, basicConfig];

  let support = {};
  testKeySystems.forEach((keySystem) => {
    let p = navigator.requestMediaKeySystemAccess(keySystem, configs)
        .then((access) => {
          // Edge doesn't return supported session types, but current versions
          // do not support persistent-license.  If sessionTypes is missing,
          // assume no support for persistent-license.
          // TODO: Polyfill Edge to return known supported session types.
          // Edge bug: https://bit.ly/2IeKzho
          let sessionTypes = access.getConfiguration().sessionTypes;
          let persistentState = sessionTypes ?
              sessionTypes.indexOf('persistent-license') >= 0 : false;

          // Tizen 3.0 doesn't support persistent licenses, but reports that it
          // does.  It doesn't fail until you call update() with a license
          // response, which is way too late.
          // This is a work-around for #894.
          if (navigator.userAgent.indexOf('Tizen 3') >= 0) {
            persistentState = false;
          }

          support[keySystem] = {persistentState: persistentState};
          return access.createMediaKeys();
        }).catch(() => {
          // Either the request failed or createMediaKeys failed.
          // Either way, write null to the support object.
          support[keySystem] = null;
        });
    tests.push(p);
  });

  return Promise.all(tests).then(() => support);
};


/**
 * @private
 */
shaka.media.DrmEngine.prototype.onPlay_ = function() {
  for (let i = 0; i < this.mediaKeyMessageEvents_.length; i++) {
    this.sendLicenseRequest_(this.mediaKeyMessageEvents_[i]);
  }

  this.initialRequestsSent_ = true;
  this.mediaKeyMessageEvents_ = [];
};


/**
 * Checks if a variant is compatible with the key system.
 * @param {!shaka.extern.Variant} variant
 * @return {boolean}
**/
shaka.media.DrmEngine.prototype.supportsVariant = function(variant) {
  if (variant.audio && variant.audio.encrypted) {
    if (!this.supportsStream(variant.audio)) { return false; }
  }

  if (variant.video && variant.video.encrypted) {
    if (!this.supportsStream(variant.video)) { return false; }
  }

  const keySystem = this.keySystem();
  return variant.drmInfos.length == 0 ||
      variant.drmInfos.some((drmInfo) => drmInfo.keySystem == keySystem);
};


/**
 * @param{shaka.extern.Stream} stream
 * @return {boolean}
 */
shaka.media.DrmEngine.prototype.supportsStream = function(stream) {
  goog.asserts.assert(
      stream.encrypted,
      'Why are you checking for drm support on a clear stream?');

  // When null it means it supports everything - because we don't actually
  // know what is supported.
  if (this.supportedTypes_ == null) {
    return true;
  }

  const streamType = shaka.util.MimeUtils.getFullType(
      stream.mimeType, stream.codecs);

  return this.supportedTypes_.some((type) => type == streamType);
};

/**
 * Checks if two DrmInfos can be decrypted using the same key system.
 * Clear content is considered compatible with every key system.
 *
 * @param {!Array.<!shaka.extern.DrmInfo>} drms1
 * @param {!Array.<!shaka.extern.DrmInfo>} drms2
 * @return {boolean}
 */
shaka.media.DrmEngine.areDrmCompatible = function(drms1, drms2) {
  if (!drms1.length || !drms2.length) return true;

  return shaka.media.DrmEngine.getCommonDrmInfos(
      drms1, drms2).length > 0;
};


/**
 * Returns an array of drm infos that are present in both input arrays.
 * If one of the arrays is empty, returns the other one since clear
 * content is considered compatible with every drm info.
 *
 * @param {!Array.<!shaka.extern.DrmInfo>} drms1
 * @param {!Array.<!shaka.extern.DrmInfo>} drms2
 * @return {!Array.<!shaka.extern.DrmInfo>}
 */
shaka.media.DrmEngine.getCommonDrmInfos = function(drms1, drms2) {
  if (!drms1.length) return drms2;
  if (!drms2.length) return drms1;

  let commonDrms = [];

  for (let i = 0; i < drms1.length; i++) {
    for (let j = 0; j < drms2.length; j++) {
      // This method is only called to compare drmInfos of a video and an audio
      // adaptations, so we shouldn't have to worry about checking robustness.
      if (drms1[i].keySystem == drms2[j].keySystem) {
        let drm1 = drms1[i];
        let drm2 = drms2[j];
        let initData = [];
        initData = initData.concat(drm1.initData || []);
        initData = initData.concat(drm2.initData || []);
        let keyIds = [];
        keyIds = keyIds.concat(drm1.keyIds);
        keyIds = keyIds.concat(drm2.keyIds);
        let mergedDrm = {
          keySystem: drm1.keySystem,
          licenseServerUri: drm1.licenseServerUri || drm2.licenseServerUri,
          distinctiveIdentifierRequired: drm1.distinctiveIdentifierRequired ||
              drm2.distinctiveIdentifierRequired,
          persistentStateRequired: drm1.persistentStateRequired ||
              drm2.persistentStateRequired,
          videoRobustness: drm1.videoRobustness || drm2.videoRobustness,
          audioRobustness: drm1.audioRobustness || drm2.audioRobustness,
          serverCertificate: drm1.serverCertificate || drm2.serverCertificate,
          initData: initData,
          keyIds: keyIds,
        };
        commonDrms.push(mergedDrm);
        break;
      }
    }
  }

  return commonDrms;
};


/**
 * Called in an interval timer to poll the expiration times of the sessions.  We
 * don't get an event from EME when the expiration updates, so we poll it so we
 * can fire an event when it happens.
 * @private
 */
shaka.media.DrmEngine.prototype.pollExpiration_ = function() {
  this.activeSessions_.forEach(function(session) {
    let old = session.oldExpiration;
    let new_ = session.session.expiration;
    if (isNaN(new_)) {
      new_ = Infinity;
    }

    if (new_ != old) {
      this.playerInterface_.onExpirationUpdated(
          session.session.sessionId, new_);
      session.oldExpiration = new_;
    }
  }.bind(this));
};


/**
 * Create a promise that will be resolved after the given amount of time as
 * elapsed.
 *
 * @param {number} seconds
 * @return {!Promise}
 * @private
 */
shaka.media.DrmEngine.timeout_ = function(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
};


/**
 * Replace the drm info used in each variant in |variants| to reflect each
 * key service in |keySystems|.
 *
 * @param {!Array.<shaka.extern.Variant>} variants
 * @param {!Object.<string, string>} keySystems
 * @private
 */
shaka.media.DrmEngine.replaceDrmInfo_ = function(variants, keySystems) {
  const drmInfos = [];

  shaka.util.MapUtils.forEach(keySystems, (keySystem, uri) => {
    drmInfos.push({
      keySystem: keySystem,
      licenseServerUri: uri,
      distinctiveIdentifierRequired: false,
      persistentStateRequired: false,
      audioRobustness: '',
      videoRobustness: '',
      serverCertificate: null,
      initData: [],
      keyIds: [],
    });
  });

  for (const variant of variants) {
    variant.drmInfos = drmInfos;
  }
};


/**
 * The amount of time, in seconds, we wait to consider a session closed.
 * This allows us to work around Chrome bug https://crbug.com/690583.
 * @private {number}
 */
shaka.media.DrmEngine.CLOSE_TIMEOUT_ = 1;

/**
 * The amount of time, in seconds, we wait to consider session loaded even if no
 * key status information is available.  This allows us to support browsers/CDMs
 * without key statuses.
 * @private {number}
 */
shaka.media.DrmEngine.SESSION_LOAD_TIMEOUT_ = 5;

/**
 * The amount of time, in seconds, we wait to batch up rapid key status changes.
 * This allows us to avoid multiple expiration events in most cases.
 * @private {number}
 */
shaka.media.DrmEngine.KEY_STATUS_BATCH_TIME_ = 0.5;
