const env = require('../config.json')
const Youtube = require('youtube-node')
const ytdl = require('ytdl-core')
const MessageUtil = require('./utils/MessageUtil.js')
const LogUtil = require('./utils/LogUtil.js')

const youtube = new Youtube()
youtube.setKey(env.googleAPIKey)
const youtubeUrl = 'https://www.youtube.com/watch?v='

class AudioModule {
  constructor () {
    this.messageUtil = new MessageUtil()
    this.logUtil = new LogUtil()

    // map of guildId to queue
    this.queues = new Map()
    // map of guildId to isRepeating boolean
    this.isRepeatings = new Map()
    // map of guildId to current volume
    this.volumes = new Map()
  }

  Message (command, message, client, callback) {
    var guildId = message.guild.id

    // 0 - mentions, 1 - audio, 2 - command
    var tokens = message.content.split(' ')
    var secondTerm = tokens[2].toLowerCase()
    var messageWithoutCommands = tokens.slice(3).join(' ').trim()

    // init playback queue, isRepeating, and volume if necessary
    if (!this.queues.has(guildId)) this.queues.set(guildId, [])
    if (!this.isRepeatings.has(guildId)) this.isRepeatings.set(guildId, false)
    if (!this.volumes.has(guildId)) this.volumes.set(guildId, 1)

    if (secondTerm === 'pause' || secondTerm === 'ps') {
      this.pause(client, message)
    } else if (secondTerm === 'resume' || secondTerm === 'rs') {
      this.resume(client, message)
    } else if (secondTerm === 'stop' || secondTerm === 's') {
      this.stop(client, message)
    } else if (secondTerm === 'volume' || secondTerm === 'v') {
      this.volume(client, message, messageWithoutCommands)
    } else if (secondTerm === 'skip' || secondTerm === 'sk') {
      this.skip(client, message)
    } else if (secondTerm === 'queue' || secondTerm === 'q') {
      this.queue(message)
    } else if (secondTerm === 'repeat' || secondTerm === 'r') {
      this.repeat(message)
    } else if (secondTerm === 'play' || secondTerm === 'p') {
      this.play(client, message, messageWithoutCommands)
    }
  }

  useVoiceConnection (client, message, callback) {
    var voiceConnection = client.voiceConnections.get(message.guild.id)
    if (voiceConnection) {
      callback(voiceConnection.player.dispatcher)
    } else {
      this.messageUtil.channel(message, 'n is not in a voice channel. Use @n help to learn how to fix that')
    }
  }

  playStream (client, voice, stream, queue, message, reason, seekTime = 0) {
    var firstQueueItem = queue[0]
    // Send stream info unless stream is repeating, or stream was skipped
    if (!this.isRepeatings.get(message.guild.id) || reason !== 'user') {
      this.messageUtil.channel(message, '\n\n`Now playing:` ' + firstQueueItem.title + '\n`Link:` ' + firstQueueItem.link + '\n`Channel:` ' + firstQueueItem.channel)
    } else {
      this.messageUtil.channel(message, '`Now repeating:` ' + firstQueueItem.title)
    }
    var streamDispatcher = voice.playStream(stream, {volume: this.getVolume(message), seek: seekTime})
    streamDispatcher.on('end', reason => {
      this.logEndReason(reason, queue[0])
      if (!this.isRepeatings.get(message.guild.id) && queue.length > 0) this.queues.set(message.guild.id, queue.length === 1 ? [] : queue.slice(1))
      var newQueue = this.queues.get(message.guild.id)
      if (newQueue.length === 0) {
        this.setIsRepeating(message, false, this.isRepeatings.get(message.guild.id))
        voice.disconnect()
        this.resetVolume(message)
        return this.messageUtil.channel(message, 'Queue playback complete')
      }
      var newStream = ytdl(newQueue[0].link, { quality: 'highest', filter: 'audioonly' })
      this.playStream(client, voice, newStream, newQueue, message, reason)
    })
  }

  logEndReason (reason, playbackItem) {
    var reasonString = 'reason: ' + reason
    var videoInfo = '\n    video: ' + playbackItem.title + '\n    link: ' + playbackItem.link + '\n'
    this.logUtil.logWithTime(reasonString + videoInfo)
  }

  pause (client, message) {
    this.useVoiceConnection(client, message, voice => {
      if (voice.paused) {
        this.messageUtil.channel(message, 'Playback is already paused')
      } else {
        voice.pause()
        this.messageUtil.channel(message, 'Playback paused')
      }
    })
  }

  resume (client, message) {
    this.useVoiceConnection(client, message, voice => {
      if (voice.paused) {
        voice.resume()
        this.messageUtil.channel(message, 'Playback resumed')
      } else {
        this.messageUtil.channel(message, 'Playback is not paused')
      }
    })
  }

  stop (client, message) {
    this.queues.set(message.guild.id, [])
    this.useVoiceConnection(client, message, voice => {
      voice.end()
    })
  }

  volume (client, message, newVolume) {
    this.useVoiceConnection(client, message, voice => {
      if (newVolume < 0 || newVolume > 400) return this.messageUtil.channel(message, 'Enter a value between 0-400')
      this.setVolume(newVolume / 100, voice, message)
      this.messageUtil.channel(message, 'volume set to ' + newVolume + '%')
    })
  }

  skip (client, message) {
    var queue = this.queues.get(message.guild.id)
    var voiceConnection = client.voiceConnections.get(message.guild.id)
    if (!voiceConnection || queue.length === 0) return this.messageUtil.channel(message, 'Nothing to skip')
    voiceConnection.player.dispatcher.end()
  }

  queue (message) {
    var guildId = message.guild.id
    var queue = this.queues.get(guildId)
    if (queue.length === 0) return this.messageUtil.channel(message, 'Nothing in queue')
    var isRepeating = this.isRepeatings.get(guildId) ? 'on' : 'off'
    var volume = (this.volumes.get(guildId) * 100) + '%'
    var replyString = '```md\ncurrently playing ↴  repeat: ' + isRepeating + '  volume: ' + volume + '\n'
    var index = 0
    queue.forEach(queueItem => {
      replyString += ++index + '. ' + queueItem.title + '\n'
    })
    this.messageUtil.channel(message, replyString + '```')
  }

  repeat (message) {
    var isRepeating = this.isRepeatings.get(message.guild.id)
    this.setIsRepeating(message, !isRepeating)
  }

  play (client, message, searchTerm) {
    var guildId = message.guild.id
    var queue = this.queues.get(guildId)

    // todo: move link checking out of this search
    youtube.search(searchTerm, 1, (err, res) => {
      if (err) return console.log(err)
      if (res.items.length === 0) return this.messageUtil.channel(message, 'No results for for that search')
      if (res.items[0].id.kind === 'youtube#playlist') return this.messageUtil.channel(message, 'No results for for that search')

      var videoId = res.items[0].id.videoId
      var videoTitle = res.items[0].snippet.title
      var channelTitle = res.items[0].snippet.channelTitle
      var requestUrl

      if (searchTerm.startsWith('http://') || searchTerm.startsWith('https://')) {
        requestUrl = searchTerm
      } else {
        requestUrl = youtubeUrl + videoId
      }
      queue.push({
        link: requestUrl,
        title: videoTitle,
        channel: channelTitle
      })
      this.queues.set(guildId, queue)

      var voiceConnection = client.voiceConnections.get(guildId)
      if (voiceConnection) {
        if (voiceConnection.speaking) return this.messageUtil.channel(message, videoTitle + ' added to the queue')
      } else {
        var stream = ytdl(requestUrl, { quality: 'highest', filter: 'audioonly' })
        var voiceChannel = message.guild.channels.find(channel => channel.type === 'voice' && channel.members.has(message.author.id))
        voiceChannel.join().then(voice => {
          this.playStream(client, voice, stream, queue, message, '')
        })
      }
    })
  }

  setIsRepeating (message, newIsRepeating, shouldMessage = true) {
    if (newIsRepeating && shouldMessage) {
      this.messageUtil.reply(message, 'Repeat current audio: `on`')
    } else if (shouldMessage) {
      this.messageUtil.reply(message, 'Repeat current audio: `off`')
    }
    this.isRepeatings.set(message.guild.id, newIsRepeating)
  }

  setVolume (volume, voice, message) {
    voice.setVolume(volume)
    this.volumes.set(message.guild.id, volume)
  }

  getVolume (message) {
    return this.volumes.get(message.guild.id)
  }

  resetVolume (message) {
    this.volumes.set(message.guild.id, 1)
  }
}

module.exports = AudioModule
