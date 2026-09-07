'use strict';

/**
 * The last `.strm` suffix is a pointer suffix.  The extension immediately
 * before it is the media type and is deliberately decided locally; no
 * request is made to the remote URL to discover a type.
 */
const DEFAULT_MEDIA_EXTENSIONS = Object.freeze([
  '.mp3', '.ogg', '.opus', '.wav', '.aac', '.flac', '.webm', '.mp4',
  '.m4a', '.mka', '.aiff', '.avi'
]);

const VIDEO_EXTENSIONS = new Set(['.mp4', '.avi', '.webm']);

function parseVirtualMediaName(fileName, mediaExtensions = DEFAULT_MEDIA_EXTENSIONS) {
  const baseName = String(fileName || '').split(/[\\/]/).pop();
  if (!/\.strm$/i.test(baseName)) {
    return { isStrm: false, valid: false, code: 'NOT_STRM' };
  }

  const logicalName = baseName.slice(0, -'.strm'.length);
  if (!logicalName) {
    return { isStrm: true, valid: false, code: 'VIRTUAL_NAME_EMPTY', logicalName };
  }
  const dotIndex = logicalName.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === logicalName.length - 1) {
    return {
      isStrm: true,
      valid: false,
      code: 'VIRTUAL_EXTENSION_MISSING',
      logicalName,
    };
  }
  const mediaExt = logicalName.slice(dotIndex).toLowerCase();
  const extensions = new Set(Array.from(mediaExtensions, value => String(value).toLowerCase()));
  if (!mediaExt) {
    return {
      isStrm: true,
      valid: false,
      code: 'VIRTUAL_EXTENSION_MISSING',
      logicalName,
    };
  }
  if (!extensions.has(mediaExt)) {
    return {
      isStrm: true,
      valid: false,
      code: 'VIRTUAL_EXTENSION_UNSUPPORTED',
      logicalName,
      mediaExt,
    };
  }
  return {
    isStrm: true,
    valid: true,
    logicalName,
    displayName: logicalName,
    mediaExt,
    isVideo: VIDEO_EXTENSIONS.has(mediaExt),
    sourceExt: '.strm',
  };
}

module.exports = {
  DEFAULT_MEDIA_EXTENSIONS,
  VIDEO_EXTENSIONS,
  parseVirtualMediaName,
};
