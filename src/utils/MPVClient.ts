import { access, createReadStream, readFile } from 'fs';
import { createInterface } from 'readline';
import { remote } from 'electron';
import mpv from 'mpv-ipc';

interface IStoredMessage {
  content: string;
  channel_id: string;
  author_displayname: string;
  color: string;
  emotes: {
    _id: string;
    begin: number;
    end: number;
  }[];
  badges: {
    _id: string;
    version: string;
  }[];
  datetime: Date;
  offset: number;
}

export default class MPVClient {
  private messages: any[] = [];

  private subscribers = {};

  private player: any;

  private lastMessageIndex = 0;

  private intervalHandle: NodeJS.Timeout;

  // Refresh happens when seeking/skipping to another part in the video
  private numMessagesOnRefresh = 30;

  constructor(numMessagesOnRefresh?: number) {
    if (numMessagesOnRefresh) {
      this.numMessagesOnRefresh = numMessagesOnRefresh;
    }
  }

  init(chatlog, socketName = 'MPVControllPipe'): Promise<void> {
    return new Promise((resolve, reject) => {
      const callback = () => {
        const socketPrefix = '\\\\.\\pipe\\';
        const socket = socketPrefix + socketName;
        this.player = new mpv.MPVClient(socket);
        this.handleSeek();
        this.player.on('close', this.disconnect.bind(this));
        this.player.on('seek', this.handleSeek.bind(this));
        if (chatlog === 'ondemand') {
          // this.player.on('chatmessages', (e) => this.handleReceivedMessages(e));
          this.player.on('chatmessages', (e) => {
            this.handleReceivedMessages(e);
          });
        }
        this.intervalHandle = setInterval(this.checkForAndEmitNewMessages.bind(this), 2000);
        resolve();
      };

      if (chatlog === 'ondemand') {
        callback();
      } else {
        access(chatlog, (err) => {
          if (err) {
            reject(err);
          }

          if (chatlog) {
            if (chatlog.endsWith('txt')) this.loadMessagesFromTxt(chatlog, callback);

            if (chatlog.endsWith('json')) this.loadMessagesFromJson(chatlog, callback);
          }
        });
      }
    });
  }

  async disconnect(): Promise<void> {
    clearInterval(this.intervalHandle);
    this.player.off('seek', this.handleSeek.bind(this));
    // this.player.off('chatmessages', this.handleReceivedMessages.bind(this));
    remote.getCurrentWindow().close();
  }

  private loadMessagesFromTxt(chatlog: string, callback: () => void) {
    const readInterface = createInterface({
      input: createReadStream(chatlog),
    });
    let startDate: Date;
    let i = 0;
    readInterface.on('line', (line) => {
      let elements = line.split(' ');
      const [day, month, year] = elements[0].split('.').map((e) => parseInt(e, 10));
      const [hours, minutes, seconds] = elements[1].split(':').map((e) => parseInt(e, 10));
      const messageDate = new Date(year, month - 1, day, hours, minutes, seconds);
      if (i === 0) {
        startDate = messageDate;
      }
      // Divide by 1000 to get seconds
      const time = (messageDate.getTime() - startDate.getTime()) / 1000;
      elements = line.split(': ');
      // eslint-disable-next-line
      const username = elements.shift()!.split(' - ')[1];
      const message = elements.join();

      this.messages.push({
        time,
        message,
        tags: {
          username,
          color: null,
          emotes: null,
          badges: null,
        },
      });
      i++;
    });

    readInterface.on('close', callback);
  }

  private loadMessagesFromJson(chatlog: string, callback: () => void) {
    readFile(chatlog, 'utf8', (err, data) => {
      if (err) {
        // TODO handle error
        console.error(`Failed to read file: ${err}`);
      }

      let storedMgs: IStoredMessage[] = [];

      try {
        storedMgs = JSON.parse(data);
      } catch (error) {
        // TODO handle error
        console.error(`Error while parsing json file: ${error}`);
      }

      this.handleNewMessages(storedMgs);

      callback();
    });
  }

  private stored2ChatMessage(storedMsg: IStoredMessage) {
    const wellformedEmotes: {} = {};
    if (storedMsg.emotes) {
      for (const emote of storedMsg.emotes) {
        if (!(emote._id in wellformedEmotes)) wellformedEmotes[emote._id] = [];
        wellformedEmotes[emote._id].push(`${emote.begin}-${emote.end}`);
      }
    }

    const wellformedBadges: {} = {};
    if (storedMsg.badges) {
      for (const badge of storedMsg.badges) {
        if (!(badge._id in wellformedBadges)) {
          wellformedBadges[badge._id] = badge.version;
        }
      }
    }

    return {
      time: storedMsg.offset,
      message: storedMsg.content,
      channel_id: storedMsg.channel_id,
      tags: {
        username: storedMsg.author_displayname,
        color: storedMsg.color,
        emotes: wellformedEmotes,
        badges: wellformedBadges,
        'room-id': storedMsg.channel_id,
      },
    };
  }

  private checkForAndEmitNewMessages() {
    this.player.getProperty('playback-time').then((time) => {
      const closestMessageIndex = this.binarySearch(this.messages, time, (e) => e.time);
      if (closestMessageIndex > this.lastMessageIndex) {
        for (let i = this.lastMessageIndex; i < closestMessageIndex; i++) {
          this.emit('message', [null, this.messages[i].tags, this.messages[i].message]);
        }
        this.lastMessageIndex = closestMessageIndex;
      }
    });
  }

  private handleSeek() {
    this.player.getProperty('playback-time').then((time) => {
      const closestMessageIndex = this.binarySearch(this.messages, time, (e) => e.time);
      this.lastMessageIndex = closestMessageIndex - this.numMessagesOnRefresh;
      if (this.lastMessageIndex < 0) {
        this.lastMessageIndex = 0;
      }
      this.emit('delete', []);
      this.checkForAndEmitNewMessages();
    });
  }

  private handleReceivedMessages(eve: { event: string; data: IStoredMessage[] }) {
    this.handleNewMessages(eve.data);
  }

  private handleNewMessages(storedMgs: IStoredMessage[]) {
    for (const storedMsg of storedMgs) this.messages.push(this.stored2ChatMessage(storedMsg));
  }

  private emit(event: string, data: any) {
    if (!Array.isArray(this.subscribers[event])) {
      return;
    }
    this.subscribers[event].forEach((callback) => {
      callback(...data);
    });
  }

  on(event: string, listener: (...args: any[]) => any) {
    if (!Array.isArray(this.subscribers[event])) {
      this.subscribers[event] = [];
    }
    this.subscribers[event].push(listener);
  }

  private binarySearch(sortedArray, key, getPredicate) {
    if (getPredicate == null) {
      getPredicate = (e) => e;
    }
    let start = 0;
    let end = sortedArray.length - 1;

    while (start <= end) {
      const mid = Math.floor((start + end) / 2);

      if (getPredicate(sortedArray[mid]) === key) {
        // found the key
        return mid;
      }
      if (getPredicate(sortedArray[mid]) < key) {
        // continue searching to the right
        start = mid + 1;
      } else {
        // search searching to the left
        end = mid - 1;
      }
    }
    // key wasn't found
    return start;
  }
}
