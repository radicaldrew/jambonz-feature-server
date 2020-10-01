const CallSession = require('./call-session');
const {CallDirection} = require('../utils/constants');

/**
 * @classdesc Subclass of CallSession.  Represents a CallSession
 * that is established for the purpose of sending an outbound SMS
 * @extends CallSession

 */
class SmsCallSession extends CallSession {
  constructor({logger, application, tasks, callInfo}) {
    super({
      logger,
      application,
      tasks,
      callInfo: Object.assign(callInfo, {direction: CallDirection.None})
    });
  }

}

module.exports = SmsCallSession;
