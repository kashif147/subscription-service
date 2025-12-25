module.exports = (req, res, next) => {
  res.success = (data) => {
    res.status(200).json({ status: 'success', data });
  };

  res.serverError = (error) => {
    if (error.isJoi) {
      let data = error.details.map((d) => d.message);
      data = data.join(', ');
      console.log(`ERROR: [${req.method}-${req.url}] ${data}`);
      res.status(400).json({ status: 'fail', data });
    } else {
      console.log(`ERROR: [${req.method}-${req.url}] ${error}`);
      res.status(500).json({ status: 'error', data: 'Server Error' });
    }
  };

  res.fail = (data) => {
    res.status(400).json({ status: 'fail', data });
  };

  res.sendResponse = (statusCode, data) => {
    res.status(statusCode).json({ status: statusCode, data });
  };

  // Standardized not found responses (200 OK instead of 404)
  res.notFoundList = (message = "No records found") => {
    res.status(200).json({
      success: true,
      data: [],
      message,
    });
  };

  res.notFoundRecord = (message = "Record not found") => {
    res.status(200).json({
      success: true,
      data: null,
      message,
    });
  };

  next();
};
