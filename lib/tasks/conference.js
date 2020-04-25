const Task = require('./task');
const Emitter = require('events');
const ConfirmCallSession = require('../session/confirm-call-session');
const {TaskName, TaskPreconditions} = require('../utils/constants');
const normalizeJambones = require('../utils/normalize-jambones');
const makeTask = require('./make_task');
const bent = require('bent');
const uuidv4 = require('uuid/v4');
const assert = require('assert');
const WAIT = 'wait';
const JOIN = 'join';
const START = 'start';

function getWaitListName(confName) {
  return `${confName}:waitlist`;
}

function camelize(str) {
  return str.replace(/(?:^\w|[A-Z]|\b\w)/g, function(word, index) {
    return index === 0 ? word.toLowerCase() : word.toUpperCase();
  })
    .replace(/\s+/g, '')
    .replace(/-/g, '');
}

function unhandled(logger, evt) {
  //logger.debug(`unhandled conference event: ${evt.getHeader('Action')}`) ;
}

function capitalize(s) {
  if (typeof s !== 'string') return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

class Conference extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.logger = logger;
    this.preconditions = TaskPreconditions.Endpoint;

    if (!this.data.name) throw new Error('conference name required');

    this.confName = this.data.name;
    [
      'beep', 'startConferenceOnEnter', 'endConferenceOnExit',
      'maxParticipants', 'waitHook', 'statusHook', 'endHook', 'enterHook'
    ].forEach((attr) => this[attr] = this.data[attr]);

    this.emitter = new Emitter();
  }

  get name() { return TaskName.Conference; }

  async exec(cs, ep) {
    await super.exec(cs);
    this.ep = ep;
    const dlg = cs.dlg;
    this.ep.on('destroy', this._kicked.bind(this, cs, dlg));

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

      /**
       * TODO: send final conference status, etc
       * unless this.callMoved === true
      */

      this.logger.debug(`Conference:exec - conference ${this.confName} is over`);
    } catch (err) {
      this.logger.info(err, `TaskConference:exec - error in conference ${this.confName}`);
    }
  }

  async kill(cs) {
    super.kill();
    this.logger.info(`Conference:kill ${this.confName}`);
    this.emitter.emit('kill');
    await this._doFinalMemberCheck(cs);
    if (this.ep && this.ep.connected) this.ep.conn.removeAllListeners('esl::event::CUSTOM::*') ;
    this.notifyTaskDone();
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
    this.confName = `conf:${cs.accountSid}:${this.confName}`;

    // check if conference is in progress
    const obj = await retrieveHash(this.confName);
    if (obj) {
      this.logger.info(`Conference:_init conference ${this.confName} is already started`);
      this.joinDetails = { conferenceSipAddress: obj.sipAddress};
      this.action = JOIN;
    }
    else {
      if (this.startConferenceOnEnter === false) {
        this.logger.info(`Conference:_init conference ${this.confName} does not exist, wait for moderator`);
        this.action = WAIT;
      }
      else {
        this.logger.info(`Conference:_init conference ${this.confName} does not exist, provision it now..`);
        const added = await createHash(this.confName, {sipAddress: cs.srf.locals.localSipAddress});
        if (added) {
          this.logger.info(`Conference:_init conference ${this.confName} successfully provisioned`);
          this.action = START;
        }
        else {
          this.logger.info(`Conference:_init conference ${this.confName} provision failed..someone beat me to it?`);
          const obj = await retrieveHash(this.confName);
          if (null === obj) {
            this.logger.error(`Conference:_init conference ${this.confName} provision failed again...exiting`);
            throw new Error('Failed to join conference');
          }
          this.joinDetails = { conferenceSipAddress: obj.sipAddress};
          this.action = JOIN;
        }
      }
    }
  }

  /**
   * Wait for entry to a conference, which means
   * - add ourselves to the waiting list for the conference,
   * - if provided, continually invoke waitHook to play or say something (pause allowed as well)
   * - wait for an event indicating the conference has started (or caller hangs up).
   *
   * Returns a Promise that is resolved when:
   * a. caller hangs up while waiting, or
   * b. conference starts, participant joins the conference
   * @param {CallSession} cs
   * @param {SipDialog} dlg
   */
  async _doWait(cs, dlg) {
    await this._addToWaitList(cs);

    return new Promise(async(resolve, reject) => {
      this.emitter
        .once('join', (opts) => {
          this.joinDetails = opts;
          this.logger.info({opts}, `time to join conference ${this.confName}`);
          if (this._playSession) this._playSession.kill();

          // return a Promise that resolves at the end of the conference for this caller
          this.emitter.removeAllListeners();
          resolve(this._doJoin(cs, dlg));
        })
        .once('kill', () => {
          this._removeFromWaitList(cs);
          if (this._playSession) {
            this.logger.debug('killing waitUrl');
            this._playSession.kill();
          }
          resolve();
        });

      if (this.waitHook) {
        do {
          try {
            await this.ep.play('silence_stream://1000');
            const tasks = await this._playHook(cs, dlg, this.waitHook);
            if (0 === tasks.length) break;
          } catch (err) {
            if (!this.joinDetails && !this.killed) {
              this.logger.info(err, `Conference:_doWait: failed retrieving waitHook for ${this.confName}`);
            }
            this._playSession = null;
            break;
          }
        } while (!this.killed && !this.joinDetails);
      }
    });
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
    await this._joinConference(cs, dlg, false);
  }

  /**
   * Start a conference and notify anyone on the waiting list
   * @param {CallSession} cs
   * @param {SipDialog} dlg
   */
  async _doStart(cs, dlg) {
    await this._joinConference(cs, dlg, true);

    // notify waiting list members
    try {
      const {retrieveSet, deleteKey} = cs.srf.locals.dbHelpers;
      const setName = getWaitListName(this.confName);
      const members = await retrieveSet(setName);
      if (Array.isArray(members) && members.length > 0) {
        this.logger.info({members}, `Conference:doStart - notifying waiting list for ${this.confName}`);
        for (const url of members) {
          try {
            await bent('POST', 202)(url, {conferenceSipAddress: cs.srf.locals.localSipAddress});
          } catch (err) {
            this.logger.info(err, `Failed notifying ${url} to join ${this.confName}`);
          }
        }
        // now clear the waiting list
        deleteKey(setName);
      }
    } catch (err) {
      this.logger.error(err, 'Conference:_doStart - error notifying wait list');
    }
  }

  async _joinConference(cs, dlg, startConf) {
    if (startConf) {
      // conference should not exist - check but continue in either case
      const result = await cs.getMS().api(`conference ${this.confName} list count`);
      const notFound = typeof result === 'string' &&
        (result.match(/^No active conferences/) || result.match(/Conference.*not found/));
      if (!notFound) {
        this.logger.info({result},
          `Conference:_joinConference: asked to start ${this.confName} but it unexpectedly exists`);
      }
      else {
        this.participantCount = 1;
      }
    }

    if (this.enterHook) {
      try {
        await this._playHook(cs, dlg, this.enterHook);
        if (!dlg.connected) {
          this.logger.debug('Conference:_doJoin: caller hung up during entry prompt');
          return;
        }
      } catch (err) {
        this.logger.error(err, `Error playing enterHook to caller for conference ${this.confName}`);
      }
    }

    const opts = {};
    if (this.endConferenceOnExit) Object.assign(opts, {flags: {endconf: true}});
    try {
      const {memberId, confUuid} = await this.ep.join(this.confName, opts);
      this.logger.debug({memberId, confUuid}, `Conference:_joinConference: successfully joined ${this.confName}`);
      this.memberId = memberId;
      this.confUuid = confUuid;

      // listen for conference events
      this.ep.filter('Conference-Unique-ID', this.confUuid);
      this.ep.conn.on('esl::event::CUSTOM::*', this.__onConferenceEvent.bind(this, cs)) ;

      // optionally play beep to conference on entry
      if (this.beep === true) {
        setTimeout(() => {
          this.ep.api('conference',
            [this.confName, 'play', 'tone_stream://v=-7;%(100,0,941.0,1477.0);v=-7;>=2;+=.1;%(1400,0,350,440)'])
            .catch((err) => {});
        }, 800);
      }

    } catch (err) {
      this.logger.error(err, `Failed to join conference ${this.confName}`);
      throw err;
    }

    if (typeof this.maxParticipants === 'number' && this.maxParticipants > 1) {
      this.endpoint.api('conference', `${this.confName} set max_members ${this.maxParticipants}`)
        .catch((err) => this.logger.error(err, `Error setting max participants to ${this.maxParticipants}`));
    }
  }

  /**
   * The conference we have been waiting for has started.
   * It may be on this server or a different one, and we are
   * given instructions how to find it and connect.
   * @param {Object} opts
   * @param {string} opts.confName name of the conference
   * @param {string} opts.conferenceSipAddress ip:port of the feature server hosting the conference
   */
  notifyStartConference(cs, opts) {
    this.logger.info({opts}, `Conference:notifyStartConference: conference ${this.confName} has now started`);
    this.emitter.emit('join', opts);
  }

  async _doRefer(cs, sipAddress) {
    const uuid = uuidv4();
    const {addKey} = cs.srf.locals.dbHelpers;
    const taskData = cs.getRemainingTaskData();
    this.logger.debug({taskData}, 'Conference:_doRefer');

    assert(taskData.length);
    const success = await addKey(uuid, JSON.stringify(taskData), 30);
    if (!success) {
      this.logger.info(`Conference:_doRefer failed storing task data before REFER for ${this.confName}`);
      return;
    }
    try {
      this.logger.info(`Conference:_doRefer: referring call to ${sipAddress} for ${this.confName}`);
      this.callMoved = true;
      const success = await cs.referCall(`sip:context-${uuid}@${sipAddress}`);
      if (!success) {
        this.callMoved = false;
        return this.logger.info('Conference:_doRefer fail');
      }
    } catch (err) {
      this.logger.error(err, 'Conference:_doRefer error');
    }
  }

  /**
   * Add ourselves to the waitlist of sessions to be notified once
   * the conference starts
   * @param {CallSession} cs
   */
  async _addToWaitList(cs) {
    const {addToSet} = cs.srf.locals.dbHelpers;
    const setName = getWaitListName(this.confName);
    const url = `${cs.srf.locals.serviceUrl}/v1/startConference/${cs.callSid}`;
    const added = await addToSet(setName, url);
    if (added !== 1) throw new Error(`failed adding to the waitlist for conference ${this.confName}: ${added}`);
    this.logger.debug(`successfully added to the waiting list for conference ${this.confName}`);
  }

  async _removeFromWaitList(cs) {
    const {removeFromSet} = cs.srf.locals.dbHelpers;
    const setName = getWaitListName(this.confName);
    const url = `${cs.srf.locals.serviceUrl}/v1/startConference/${cs.callSid}`;
    try {
      const count = await removeFromSet(setName, url);
      this.logger.debug(`Conference:_removeFromWaitList removed ${count} from waiting list`);
    } catch (err) {
      this.logger.info(err, 'Error removing from waiting list');
    }
  }

  /**
   * If we are the last one leaving the conference - turn out the lights.
   * Remove the conference info from the realtime database.
   * @param {*} cs 
   */
  async _doFinalMemberCheck(cs) {
    this.logger.debug(`leaving conference ${this.confName}, member count is ${this.participantCount}`);

    /**
     * when we hang up as the last member, the current member count = 1
     * when we are kicked out of the call when the moderator leaves, the member count = 0
     */
    if (this.participantCount <= 1) {
      const {deleteKey} = cs.srf.locals.dbHelpers;
      try {
        const removed = await deleteKey(this.confName);
        this.logger.info(`conf ${this.confName} deprovisioned: ${removed ? 'success' : 'failure'}`);
      }
      catch (err) {
        this.logger.error(err, `Error deprovisioning conference ${this.confName}`);
      }
    }
  }

  async _playHook(cs, dlg, hook, allowed = [TaskName.Play, TaskName.Say, TaskName.Pause]) {
    assert(!this._playSession);
    const json = await cs.application.requestor.request(hook, cs.callInfo);

    const allowedTasks = json.filter((task) => allowed.includes(task.verb));
    if (json.length !== allowedTasks.length) {
      this.logger.debug({json, allowedTasks}, 'unsupported task');
      throw new Error(`unsupported verb in dial conference wait/enterHook: only ${JSON.stringify(allowed)}`);
    }
    this.logger.debug(`Conference:_playHook: executing ${json.length} tasks`);

    if (json.length > 0) {
      const tasks = normalizeJambones(this.logger, json).map((tdata) => makeTask(this.logger, tdata));
      this._playSession = new ConfirmCallSession({
        logger: this.logger,
        application: cs.application,
        dlg,
        ep: cs.ep,
        callInfo: cs.callInfo,
        tasks
      });
      await this._playSession.exec();
      this._playSession = null;
    }
    return json;
  }

  /**
   * This event triggered when we are bounced from conference when moderator leaves.
   * Get a new endpoint up and running in case the app wants to go on (e.g post-call survey)
   * @param {*} cs CallSession
   * @param {*} dlg SipDialog
   */
  _kicked(cs, dlg) {
    this.logger.info(`Conference:kicked - I was dropped from conference ${this.confName}, task is complete`);
    this.replaceEndpointAndEnd(cs);
  }

  async replaceEndpointAndEnd(cs) {
    if (this.replaced) return;
    this.replaced = true;
    try {
      this.ep = await cs.replaceEndpoint();
    } catch (err) {
      this.logger.error(err, 'Conference:replaceEndpointAndEnd failed');
    }
    this.kill(cs);
  }

  __onConferenceEvent(cs, evt) {
    const eventName = evt.getHeader('Event-Subclass') ;
    if (eventName === 'conference::maintenance') {
      const action = evt.getHeader('Action') ;

      //invoke a handler for this action, if we have defined one
      const functionName = `_on${capitalize(camelize(action))}`;
      (Conference.prototype[functionName] || unhandled).bind(this, this.logger, cs, evt)() ;
    }
    else {
      this.logger.debug(`Conference#__onConferenceEvent: got unhandled custom event: ${eventName}`) ;
    }
  }

  // conference event handlers
  _onAddMember(logger, cs, evt) {
    logger.debug(`Conference#_onAddMember: ${JSON.stringify(this)}`) ;
    const size = this.participantCount = parseInt(evt.getHeader('Conference-Size'));
    const newMemberId = parseInt(evt.getHeader('Member-ID'))  ;

    logger.debug(`Conference#_onAddMember: added member ${newMemberId} to ${this.name} size is ${size}`) ;
  }

  _onDelMember(logger, cs, evt) {
    const memberId = parseInt(evt.getHeader('Member-ID')) ;
    const size = this.participantCount = parseInt(evt.getHeader('Conference-Size'));
    logger.debug(`Conference#_onDelMember: removed member ${memberId} from ${this.name} size is ${size}`) ;
    if (memberId === this.memberId) {
      this.logger.info(`Conference:_onDelMember - I was dropped from conference ${this.confName}, task is complete`);
      this.replaceEndpointAndEnd(cs);
    }
  }

}

module.exports = Conference;
