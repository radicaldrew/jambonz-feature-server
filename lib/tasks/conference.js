const Task = require('./task');
const Emitter = require('events');
const ConfirmCallSession = require('../session/confirm-call-session');
const {TaskName, TaskPreconditions} = require('../utils/constants');
const normalizeJambones = require('../utils/normalize-jambones');
const makeTask = require('./make_task');
const bent = require('bent');
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
  logger.debug(`unhandled conference event: ${evt.getHeader('Action')}`) ;
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

    this.data = opts.target[0];
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

      // TODO: send final conference status, etc
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
    if (cs.callGone) this.ep.destroy().catch(() => {});
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
   * - wait for an event indicating the conference has started.
   *
   * Returns a Promise that is resolved when:
   * a. caller hangs up while waiting
   * -b. conference starts, participant joins the conference
   * @param {CallSession} cs
   * @param {SipDialog} dlg
   */
  async _doWait(cs, dlg) {
    await this._addToWaitList(cs);

    return new Promise(async(resolve, reject) => {
      let waitCallSession;
      this.emitter
        .on('join', (opts) => {
          this.joinDetails = opts;
          this.logger.info({opts}, `time to join conference ${this.confName}`);
          if (waitCallSession) waitCallSession.kill();
          resolve(this._doJoin(cs, dlg));
        })
        .on('kill', () => {
          this._removeFromWaitList(cs);
          if (waitCallSession) {
            this.logger.debug('killing waitUrl');
            waitCallSession.kill();
          }
          resolve();
        });

      if (this.waitHook) {
        do {
          try {
            const json = await cs.application.requestor.request(this.waitHook, cs.callInfo);

            // verify it contains only allowed verbs
            const allowedTasks = json.filter((task) => {
              return [
                TaskName.Play,
                TaskName.Say,
                TaskName.Pause,
              ].includes(task.verb);
            });
            if (json.length !== allowedTasks.length) {
              this.logger.debug({json, allowedTasks}, 'unsupported task');
              throw new Error('unsupported verb in waitHook in dial conference: only play, say and pause allowed');
            }
            this.logger.debug(`Conference:_doWait: executing ${json.length} tasks`);

            // if no tasks are returned, then stop polling waitHook
            if (0 === json.length) break;

            // TODO: should rate limit requests to waitHook to protect against malicious apps

            // now execute it in a new ConfirmCallSession
            const tasks = normalizeJambones(this.logger, json).map((tdata) => makeTask(this.logger, tdata));
            waitCallSession = new ConfirmCallSession({
              logger: this.logger,
              application: cs.application,
              dlg,
              ep: cs.ep,
              callInfo: cs.callInfo,
              tasks
            });
            await waitCallSession.exec();
          } catch (err) {
            if (!this.joinDetails && !this.killed) {
              this.logger.info(err, `Conference:_doWait: failed retrieving waitHook for ${this.confName}`);
            }
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
    if (this.enterHook) {
      try {
        const tasks = await cs.requestor.request(this.waitHook, cs.callInfo);

        // verify it contains only allowed verbs
        const allowedTasks = tasks.filter((task) => {
          return [
            TaskName.Play,
            TaskName.Say,
            TaskName.Pause,
          ].includes(task.verb);
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
    await this._joinConference(cs, false);
  }

  /**
   * Start a conference and notify anyone on the waiting list
   * @param {CallSession} cs
   * @param {SipDialog} dlg
   */
  async _doStart(cs, dlg) {
    await this._joinConference(cs, true);

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

  async _joinConference(cs, startConf) {
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

  _doRefer(cs, sipAddress) {
    // TODO: send REFER to SBC
    // must include sip address to refer-to as well as
    // context to let other feature reconstruct the current task list
    throw new Error('not implemented');
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

  async _doFinalMemberCheck(cs) {
    this.logger.debug(`leaving conference ${this.confName}, member count is ${this.participantCount}`);
    if (this.participantCount === 1) {
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
    const size = this.participantCount = parseInt(evt.getHeader('Conference-Size'));
    const newMemberId = parseInt(evt.getHeader('Member-ID'))  ;

    logger.debug(`Conference#_onAddMember: added member ${newMemberId} to ${this.name} size is ${size}`) ;
  }

  _onDelMember(logger, evt) {
    const memberId = parseInt(evt.getHeader('Member-ID')) ;
    const size = this.participantCount = parseInt(evt.getHeader('Conference-Size'));
    logger.debug(`Conference#_onDelMember: removed member ${memberId} from ${this.name} size is ${size}`) ;
  }

}

module.exports = Conference;
