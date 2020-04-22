const Task = require('./task');
const Emitter = require('events');
const ConfirmCallSession = require('../session/confirm-call-session');
const {TaskName, TaskPreconditions} = require('../utils/constants');
const assert = require('assert');

const WAIT = 'wait';
const JOIN = 'join';
const START = 'start';

function camelize(str) {
  return str.replace(/(?:^\w|[A-Z]|\b\w)/g, function(word, index) {
    return index === 0 ? word.toLowerCase() : word.toUpperCase();
  }).replace(/\s+/g, '');
}

function unhandled(logger, evt) {
  logger.debug(`unhandled conference event: ${evt.getHeader('Action')}`) ;
}

function capitalize(s) {
  if (typeof s !== 'string') return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

class Conference extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.StableCall;

    this.logger = logger;
    [
      'name', 'beep', 'startConferenceOnEnter', 'endConferenceOnExit',
      'maxParticipants', 'waitHook', 'statusHook', 'endHook', 'enterHook'
    ].forEach((attr) => this[attr] = opts[attr]);

    if (!this.name) throw new Error('conference name required');

    this.emitter = new Emitter();
  }

  get name() { return TaskName.Conference; }

  async exec(cs, dlg) {
    this.ep = cs.ep;
    try {
      await this._init(cs, dlg);
      switch (this.action) {
        case JOIN:
          await this._doJoin(cs, dlg);
          break;
        case WAIT:
          await this._doWait(cs, dlg);
          break;
        case START:
          await this._doStart(cs, dlg);
          break;
      }
      await this.awaitTaskDone();

      // TODO: send final status, etc
    } catch (err) {
      this.logger.info(err, `TaskConference:exec - error in conference ${this.confName}`);
    }

  }

  async kill() {
    super.kill();
    this.logger.info(`Conference:kill ${this.confName}`);
    this.emitter.emit('kill');
  }

  /**
   * Determine which of three states we are in:
   * (1) Conference already exists -- we should JOIN
   * (2) Conference does not exist, and we should START it
   * (3) Conference does not exist, and we must WAIT for moderator
   * @param {CallSession} cs
   * @param {SipDialog} dlg
   */
  async _init(cs, dlg) {
    const {createHash, retrieveHash} = cs.srf.locals.dbHelpers;
    this.confName = `conf:${cs.accountSid}:${this.name}`;

    // check if conference is in progress
    const obj = await retrieveHash(this.confName);
    if (obj) {
      this.logger.info(`ConferenceDialer: conference ${this.confName} is already started`);
      this.joinDetails = { conferenceSipAddress: obj.sipAddress};
      this.action = JOIN;
    }
    else {
      if (this.startConferenceOnEnter === false) {
        this.logger.info(`ConferenceDialer: conference ${this.confName} does not exist, wait for moderator`);
        this.action = WAIT;
      }
      else {
        this.logger.info(`ConferenceDialer: conference ${this.confName} does not exist, provision it now..`);
        const added = await createHash(this.confName, {sipAddress: cs.srf.locals.localSipAddress});
        if (added) {
          this.logger.info(`ConferenceDialer: conference ${this.confName} successfully provisioned`);
          this.action = START;
        }
        else {
          this.logger.info(`ConferenceDialer: conference ${this.confName} provision failed..someone beat me to it?`);
          const obj = await retrieveHash(this.confName);
          if (null === obj) {
            this.logger.error(`ConferenceDialer: conference ${this.confName} provision failed again...exiting`);
            throw new Error('Failed to join conference');
          }
          this.joinDetails = { conferenceSipAddress: obj.sipAddress};
          this.action = JOIN;
        }
      }
    }
  }

  /**
   * Continually invoke waitHook, which can return only play, say, or pause verbs
   * Listen for events indicating either:
   * - the conference has started
   * - the caller has hung up
   * @param {CallSession} cs
   * @param {SipDialog} dlg
   */
  async _doWait(cs, dlg) {
    if (this.waitHook) {
      let waitCallSession;
      this.emitter
        .on('join', (opts) => {
          this.joinDetails = opts;
          this.logger.info({opts}, `time to join conference ${this.confName}`);
          if (waitCallSession) waitCallSession.kill();
        })
        .on('kill', () => {
          if (waitCallSession) waitCallSession.kill();
        });

      do {
        try {
          const tasks = await cs.requestor.request(this.waitHook, cs.callInfo);

          // verify it contains only allowed verbs
          const allowedTasks = tasks.filter((task) => {
            return [
              TaskName.Play,
              TaskName.Say,
              TaskName.Pause,
            ].includes(task.name);
          });
          if (tasks.length !== allowedTasks.length) {
            throw new Error('unsupported verb in waitHook in dial conference: only play, say and pause allowed');
          }
          this.logger.debug(`Conference:_doWait: executing ${tasks.length} tasks`);

          // if no tasks are returned, then stop polling waitHook
          if (0 === tasks.length) break;

          // TODO: should rate limit requests to waitHook to protect against malicious apps

          // now execute it in a new ConfirmCallSession
          waitCallSession = new ConfirmCallSession({
            logger: this.logger,
            application: cs.application,
            dlg: dlg,
            ep: cs.ep,
            callInfo: cs.callInfo,
            tasks
          });
          await waitCallSession.exec();
        } catch (err) {
          if (!this.joinDetails && !this.callGone) this.logger.error(err, 'Error playing waitHook in conference');
          break;
        }
      } while (true);
    }

    /**
     * either:
     * (1) we got a join event while playing waitHook
     * (2) the caller hung up
     * (3) there was no waitHook, and we should simply wait for join event
     * (4) waitHook failed for some reason, but we still want to wait for join
     */
    if (this.callGone) return;

    if (this.joinDetails) return await this._doJoin(cs, dlg);
    else {
      this.emitter.removeAllListeners();

      return new Promise((resolve) => {
        this.emitter
          .on('join', (opts) => {
            this.joinDetails = opts;
            this.logger.info({opts}, `time to join conference ${this.confName}`);
            resolve(this._doJoin(cs, dlg));
          })
          .on('kill', () => {
            resolve();
          });
      });
    }
  }

  /**
   * Join a conference that has already been started.
   * The conference may be homed on this feature server, or another one -
   * in the latter case, move the call to the other server via REFER
   * @param {CallSession} cs
   * @param {SipDialog} dlg
   */
  async _doJoin(cs, dlg) {
    assert(this.joinDetails.conferenceSipAddress);
    if (cs.srf.locals.localSipAddress !== this.joinDetails.conferenceSipAddress) {
      this.logger.info({
        localServer: cs.srf.locals.localSipAddress,
        confServer: this.joinDetails.conferenceSipAddress
      }, `Conference:_doJoin: conference ${this.confName} is hosted elsewhere`);
      await this._doRefer(cs, this.joinDetails.conferenceSipAddress);
      this.notifyTaskDone();
      return;
    }

    this.logger.info(`Conference:_doJoin: conference ${this.confName} is hosted locally`);
    if (this.enterHook) {
      try {
        const tasks = await cs.requestor.request(this.waitHook, cs.callInfo);

        // verify it contains only allowed verbs
        const allowedTasks = tasks.filter((task) => {
          return [
            TaskName.Play,
            TaskName.Say,
            TaskName.Pause,
          ].includes(task.name);
        });
        if (tasks.length !== allowedTasks.length) {
          throw new Error('unsupported verb in enterHook in dial conference: only play, say and pause allowed');
        }

        // now execute it in a new ConfirmCallSession
        this.logger.debug(`Conference:_doJoin: executing ${tasks.length} tasks on conference entry`);

        const enterCallSession = new ConfirmCallSession({
          logger: this.logger,
          application: cs.application,
          dlg,
          ep: cs.ep,
          callInfo: cs.callInfo,
          tasks
        });
        await enterCallSession.exec();
        if (!dlg.connected) {
          this.logger.debug('Conference:_doJoin: caller hung up during entry prompt');
          return;
        }
      } catch (err) {
        this.logger.error(err, `Error playing enterHook to caller for conference ${this.confName}`);
      }
    }

    // connect the endpoint into the conference
    await this._joinConference(false);

    // wait until we we are killed for some reason
    return new Promise((resolve) => this.emitter.on('kill', () => resolve()));
  }

  /**
   * Start a conference
   * @param {CallSession} cs
   * @param {SipDialog} dlg
   */
  async _doStart(cs, dlg) {
    await this._joinConference(true);

    // wait until we we are killed for some reason
    return new Promise((resolve) => this.emitter.on('kill', () => resolve()));
  }

  async _joinConference(startConf) {
    if (startConf) {
      // conference should not exist - check but continue in either case
      const result = await this.ep.api(`conference ${this.confName} list count`);
      const notFound = typeof result === 'string' &&
        (result.match(/^No active conferences/) || result.match(/Conference.*not found/));
      if (!notFound) {
        this.logger.info(`Conference:_joinConference: asked to start ${this.confName} but it unexpectedly exists`);
      }
    }

    const opts = {flags:[]};
    if (this.endConferenceOnExit) opts.flags.push('endconf');
    try {
      const {memberId, confUuid} = await this.ep.join(this.confName, opts);
      this.logger.debug({memberId, confUuid}, `Conference:_joinConference: successfully joined ${this.confName}`);
      this.memberId = memberId;
      this.confUuid = confUuid;

      // listen for conference events
      this.ep.filter('Conference-Unique-ID', this.confUuid);
      this.ep.conn.on('esl::event::CUSTOM::*', this.__onConferenceEvent.bind(this)) ;
    } catch (err) {
      this.logger.error(err, `Failed to join conference ${this.confName}`);
      throw err;
    }

    if (typeof this.maxParticipants === 'number' && this.maxParticipants > 1) {
      this.endpoint.api('conference', `${this.confName} set max_members ${this.maxParticipants}`)
        .catch((err) => this.logger.error(err, `Error setting max participants to ${this.maxParticipants}`));
    }
  }

  _doRefer(cs, sipAddress) {
    // TODO: send REFER to SBC
    // must include sip address to refer-to as well as
    // context to let other feature reconstruct the current task list
    throw new Error('not implemented');
  }

  __onConferenceEvent(evt) {
    const eventName = evt.getHeader('Event-Subclass') ;
    if (eventName === 'conference::maintenance') {
      const action = evt.getHeader('Action') ;
      this.logger.debug(`Conference#__onConferenceEvent: conference ${this.confName} event action: ${action}`) ;

      //invoke a handler for this action, if we have defined one
      const functionName = `_on${capitalize(camelize(action))}`;
      (Conference.prototype[functionName] || unhandled).bind(this, this.logger, evt)() ;
    }
    else {
      this.logger.debug(`Conference#__onConferenceEvent: got unhandled custom event: ${eventName}`) ;
    }
  }

  // conference event handlers
  _onAddMember(logger, evt) {
    logger.debug(`Conference#_onAddMember: ${JSON.stringify(this)}`) ;
    const size = parseInt(evt.getHeader('Conference-Size')); //includes control leg
    const newMemberId = parseInt(evt.getHeader('Member-ID'))  ;
    const memberType = evt.getHeader('Member-Type') ;
    const memberGhost = evt.getHeader('Member-Ghost') ;
    const channelUuid = evt.getHeader('Channel-Call-UUID') ;
    const obj = {
      memberId: newMemberId,
      type: memberType,
      ghost: memberGhost,
      channelUuid: channelUuid
    } ;
    this.participants.set(newMemberId, obj) ;

    logger.debug(`Conference#_onAddMember: added member ${newMemberId} to ${this.name} size is ${size}`) ;
  }

  _onDelMember(logger, evt) {
    const memberId = parseInt(evt.getHeader('Member-ID')) ;
    const size = parseInt(evt.getHeader('Conference-Size'));  // includes control leg
    this.participants.delete(memberId) ;
    logger.debug(`Conference#_onDelMember: removed member ${memberId} from ${this.name} size is ${size}`) ;
  }

}

module.exports = Conference;
