const router = require('express').Router();
const sysError = require('./error');
const Requestor = require('../../utils/requestor');

router.post('/:partner', async(req, res) => {
  const {logger} = req.app.locals;

  logger.debug({body: req.body}, `got incomingSms request from partner ${req.params.partner}`);

  try {
    const hook = req.body.messaging_hook;
    const requestor = new Requestor(logger, hook);
    const payload = Object.assign({provider: req.params.partner}, req.body);
    delete payload.messaging_hook;
    const obj = await requestor.request(hook, payload);
    logger.info({obj}, 'response from incoming SMS webhook');
    res.status(201).json({sid: 'foobar'});
  } catch (err) {
    sysError(logger, res, err);
  }


});

module.exports = router;
