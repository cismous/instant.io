var createTorrent = require('create-torrent')
var debug = require('debug')('instant.io')
var dragDrop = require('drag-drop')
var listify = require('listify')
var path = require('path')
var prettyBytes = require('pretty-bytes')
var throttle = require('throttleit')
var thunky = require('thunky')
var uploadElement = require('upload-element')
var WebTorrent = require('webtorrent')
var xhr = require('xhr')

var util = require('./util')

global.WEBTORRENT_ANNOUNCE = createTorrent.announceList
  .map(function (arr) {
    return arr[0]
  })
  .filter(function (url) {
    return url.indexOf('wss://') === 0 || url.indexOf('ws://') === 0
  })

if (!WebTorrent.WEBRTC_SUPPORT) {
  util.error('This browser is unsupported. Please use a browser with WebRTC support.')
}

var getClient = thunky(function (cb) {
  function createClient(rtcConfig) {
    var client = window.client = new WebTorrent({rtcConfig: rtcConfig});
    client.on('warning', util.warning);
    client.on('error', util.error);
    cb(null, client)
  }

  var rtcConfig = {
    "iceServers": [{
      "url": "stun:23.21.150.121",
      "urls": "stun:23.21.150.121"
    }, {
      "url": "turn:global.turn.twilio.com:3478?transport=udp",
      "username": "ce023496d2ee934d59273ec55421f1a5e082957d0d5dc002bf88d2e11b05d150",
      "credential": "tPYRXGYOlOe/tDcowENiFnbSJtjx8KPWNhP/KHmi5Bc=",
      "urls": "turn:global.turn.twilio.com:3478?transport=udp"
    }]
  };
  createClient(rtcConfig);
});

// For performance, create the client immediately
getClient(function () {})

// Seed via upload input element
var upload = document.querySelector('input[name=upload]')
uploadElement(upload, function (err, files) {
  if (err) return util.error(err)
  files = files.map(function (file) { return file.file })
  onFiles(files)
})

// Seed via drag-and-drop
dragDrop('body', onFiles)

// Download via input element
document.querySelector('form').addEventListener('submit', function (e) {
  e.preventDefault()
  downloadTorrent(document.querySelector('form input[name=torrentId]').value.trim())
})

// Download by URL hash
onHashChange()
window.addEventListener('hashchange', onHashChange)
function onHashChange () {
  var hash = decodeURIComponent(window.location.hash.substring(1)).trim()
  if (hash !== '') downloadTorrent(hash)
}

// Warn when leaving and there are no other peers
window.addEventListener('beforeunload', onBeforeUnload)

// Register a protocol handler for "magnet:" (will prompt the user)
navigator.registerProtocolHandler('magnet', window.location.origin + '#%s', 'Instant.io')

function getRtcConfig (url, cb) {
  xhr(url, function (err, res) {
    if (err || res.statusCode !== 200) {
      cb(new Error('Could not get WebRTC config from server. Using default (without TURN).'))
    } else {
      var rtcConfig
      try {
        rtcConfig = JSON.parse(res.body)
      } catch (err) {
        return cb(new Error('Got invalid WebRTC config from server: ' + res.body))
      }
      debug('got rtc config: %o', rtcConfig)
      cb(null, rtcConfig)
    }
  })
}

function onFiles (files) {
  debug('got files:')
  files.forEach(function (file) {
    debug(' - %s (%s bytes)', file.name, file.size)
  })

  // .torrent file = start downloading the torrent
  files.filter(isTorrentFile).forEach(downloadTorrentFile)

  // everything else = seed these files
  seed(files.filter(isNotTorrentFile))
}

function isTorrentFile (file) {
  var extname = path.extname(file.name).toLowerCase()
  return extname === '.torrent'
}

function isNotTorrentFile (file) {
  return !isTorrentFile(file)
}

function downloadTorrent (torrentId) {
  util.log('Downloading torrent from ' + torrentId)
  getClient(function (err, client) {
    if (err) return util.error(err)
    client.add(torrentId, onTorrent)
  })
}

function downloadTorrentFile (file) {
  util.log('Downloading torrent from <strong>' + file.name + '</strong>')
  getClient(function (err, client) {
    if (err) return util.error(err)
    client.add(file, onTorrent)
  })
}

function seed (files) {
  if (files.length === 0) return
  util.log('Seeding ' + files.length + ' files')

  // Seed from WebTorrent
  getClient(function (err, client) {
    if (err) return util.error(err)
    client.seed(files, onTorrent)
  })
}

function onTorrent (torrent) {
  upload.value = upload.defaultValue // reset upload element

  var torrentFileName = path.basename(torrent.name, path.extname(torrent.name)) + '.torrent'

  util.log('"' + torrentFileName + '" contains ' + torrent.files.length + ' files:')
  torrent.files.forEach(function (file) {
    util.log('&nbsp;&nbsp;- ' + file.name + ' (' + prettyBytes(file.length) + ')')
  })

  util.log(
    'Torrent info hash 值: ' + torrent.infoHash + ' ' +
    '<a href="/#' + torrent.infoHash + '" onclick="prompt(\'Share this link with anyone you want to download this torrent:\', this.href);return false;">[分享链接]</a> ' +
    '<a href="' + torrent.magnetURI + '" target="_blank">[磁力链接]</a> ' +
    '<a href="' + torrent.torrentFileBlobURL + '" target="_blank" download="' + torrentFileName + '">[下载BT种子]</a>'
  )

  function updateSpeed() {
    var progress = (100 * torrent.progress).toFixed(1);
    util.updateSpeed(
      '<b>连接用户:</b> ' + torrent.swarm.wires.length + ' ' +
      '<b>进度:</b> ' + progress + '% ' +
      '<b>下载速度:</b> ' + prettyBytes(window.client.downloadSpeed) + '/s ' +
      '<b>上传速度:</b> ' + prettyBytes(window.client.uploadSpeed) + '/s'
    )
  }

  torrent.on('download', throttle(updateSpeed, 250));
  torrent.on('upload', throttle(updateSpeed, 250));
  setInterval(updateSpeed, 5000);
  updateSpeed();

  torrent.files.forEach(function (file) {
    // append file
    file.appendTo(util.logElem, function (err, elem) {
      if (err) return util.error(err)
    });

    // append download link
    file.getBlobURL(function (err, url) {
      if (err) return util.error(err);

      var a = document.createElement('a');
      a.target = '_blank';
      a.download = file.name;
      a.href = url;
      a.textContent = '下载 ' + file.name;
      util.log(a)
    })
  })
}

function onBeforeUnload (e) {
  if (!e) e = window.event;

  if (!window.client || window.client.torrents.length === 0) return

  var isLoneSeeder = window.client.torrents.some(function (torrent) {
    return torrent.swarm && torrent.swarm.numPeers === 0 && torrent.progress === 1
  });
  if (!isLoneSeeder) return;

  var names = listify(window.client.torrents.map(function (torrent) {
    return '"' + (torrent.name || torrent.infoHash) + '"'
  }));

  var theseTorrents = window.client.torrents.length >= 2
    ? 'these torrents'
    : 'this torrent';
  var message = 'You are the only person sharing ' + names + '. ' +
    'Consider leaving this page open to continue sharing ' + theseTorrents + '.';

  if (e) e.returnValue = message; // IE, Firefox
  return message; // Safari, Chrome
}
