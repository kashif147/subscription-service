module.exports = (req, res, next) => {
  console.log(`${req.method} - ${req.url}`);
  switch (req.method) {
    case 'GET':
    case 'DELETE':
      if (req.params && Object.keys(req.params).length) {
        console.log(`PARAMETERS:`);
        console.log(req.params);
      }
      if (req.query && Object.keys(req.query).length) {
        console.log(`QUERY:`);
        console.log(req.query);
      }
      break;
    case 'POST':
    case 'PUT':
      if (req.body && Object.keys(req.body).length) {
        console.log(`BODY:`);
        console.log(req.body);
      }
      break;
    default:
      break;
  }
  next();
};
