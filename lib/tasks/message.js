const Task = require('./task');
const {TaskName, TaskPreconditions} = require('../utils/constants');

class TaskMessage extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.None;

    this.headers = this.data.headers || {};

  }

  get name() { return TaskName.Message; }

  /**
   * Send outbound SMS
   */
  async exec(cs, dlg) {
    await super.exec(cs);
    try {

    } catch (err) {
      this.logger.error(err, 'TaskMessage:exec - Error sending SMS');
    }
  }
}

module.exports = TaskMessage;
