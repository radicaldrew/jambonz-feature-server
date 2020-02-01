const Task = require('./task');
const {TaskName} = require('../utils/constants');

/**
 * Manages an outdial made via REST API
 */
class TaskRestDial extends Task {
  constructor(logger, opts) {
    super(logger, opts);

    this.from = this.data.from;
    this.to = this.data.to;
    this.call_hook = this.data.call_hook;
    this.timeout = this.data.timeout || 60;

    this.on('connect', this._onConnect.bind(this));
    this.on('callStatus', this._onCallStatus.bind(this));
  }

  get name() { return TaskName.RestDial; }

  /**
   * INVITE has just been sent at this point
  */
  async exec(cs, req) {
    super.exec(cs);
    this.req = req;

    this._setCallTimer();
    await this.awaitTaskDone();
  }

  kill() {
    super.kill();
    this._clearCallTimer();
    if (this.req) {
      this.req.cancel();
      this.req = null;
    }
    this.notifyTaskDone();
  }

  async _onConnect(dlg) {
    this.req = null;
    const cs = this.callSession;
    cs.setDialog(dlg);
    const obj = Object.assign({}, cs.callInfo);

    const tasks = await this.actionHook(this.call_hook, obj);
    if (tasks && Array.isArray(tasks)) {
      this.logger.debug({tasks: tasks}, `TaskRestDial: replacing application with ${tasks.length} tasks`);
      cs.replaceApplication(tasks);
    }
    this.notifyTaskDone();
  }

  _onCallStatus(status) {
    this.logger.debug(`CallStatus: ${status}`);
    if (status >= 200) {
      this.req = null;
      this._clearCallTimer();
      if (status !== 200) this.notifyTaskDone();
    }
  }

  _setCallTimer() {
    this.timer = setTimeout(this._onCallTimeout.bind(this), this.timeout * 1000);
  }

  _clearCallTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  _onCallTimeout() {
    this.logger.debug('TaskRestDial: timeout expired without answer, killing task');
    this.timer = null;
    this.kill();
  }
}

module.exports = TaskRestDial;