const axios = require('axios');
const verify = require('@trellisfw/signatures').verify;
const _ = require('lodash');
const Promise = require('bluebird');

const config = require('../config.js')
const debug = require('debug')('trellis-service-ibmfoodtrust:getDocsForHyperledger')
/*
  Only push certifications to hyperledger:
    - if they haven't been pushed already (do not contain a '/_meta/hyperledger_id' key)
    - if both the certificate and audit are signed.
    - if both the certificate and audit's signatures are verified.
    - if either the certificate or the audit have a `organization.gln` key
  '/_meta/hyperledger_id'
*/

function isSignedAndValid(doc) {
  return Promise.try(() => {
    const signatures = _.get(doc, 'signatures');
    if (signatures == null || !_.isArray(signatures) || signatures.length == 0) {
      throw new Error('Not signed.');
    }
    if (_.get(config, 'debug.verifySignatures') === false) {
      return true;
    }
    return verify(doc);
  })
}

function getDocsForHyperledger({token}) {
  /*
    Get /bookmarks/certifications
  */
  var docs = [];
  return axios({
    method: 'GET',
    url: config.api+'/bookmarks/certifications',
    headers: {
      Authorization: 'Bearer '+token
    }
  }).then((response) => {
    //Extract only list of certification ids
    var certKeys = _.filter(Object.keys(response.data), key=>(_.startsWith(key, '_')===false));
    return Promise.map(certKeys, (key) => {
      //We need the certificate as well as the audit from the certification in order to build the hyperledger doc.
      //Each doc in hyperledger represents a certification but includes audit AND certificate data.
      //The hyperledger_id will be stored on the certification
      //Only push certifications to hyperledger:
      // - if they haven't been pushed already (do not contain a '/_meta/hyperledger_id' key)
      // - if both the certificate and audit are signed.
      // - if both the certificate and audit's signatures are verified.
      // - if either the certificate or the audit have a `organization.gln` key

      //Get the certification to check if it has been pushed already
      return Promise.try(() => {
        return axios({
          method: 'GET',
          url: config.api+'/bookmarks/certifications/'+key,
          headers: {
            Authorization: 'Bearer '+token
          }
        });
      }).then((certificationResponse) => {
        const hyperledgerId = _.get(certificationResponse, 'data._meta.hyperledger_id');
        if (hyperledgerId) throw new Error('Certification already pushed to hyperledger');
        const certification = certificationResponse.data;
        return {certification: certificationResponse.data};
      }).then(({certification}) => {
        //Get the certificate and the audit from the certification
        return Promise.join(
          axios({
            method: 'GET',
            url: config.api+'/bookmarks/certifications/'+key+'/audit',
            headers: {
              Authorization: 'Bearer '+token
            }
          }),
          axios({
            method: 'GET',
            url: config.api+'/bookmarks/certifications/'+key+'/certificate',
            headers: {
              Authorization: 'Bearer '+token
            }
          }),
          (auditResponse, certificateResponse) => {
            return {certification, audit: auditResponse.data, certificate: certificateResponse.data}
          }).catch((err) => {
            debug('Failed to load audit and/or certificate for', key);
            throw new Error('Failed to load audit and/or certificate');
          });
      }).tap(({audit, certificate}) => {
        //Check if the audit and certificate are signed and valid
        const certSignatures = _.get(certificate, 'data.signatures');
        return Promise.join(isSignedAndValid(audit), isSignedAndValid(certificate));
      }).tap(({audit, certificate}) => {
        //Check if either the certificate or the audit have a `organization.gln`
        if (!(_.get(audit, 'organization.gln')) && !(_.get(certificate, 'organization.gln'))) {
          throw new Error('No organization.gln on audit or certificate');
        }
      }).catch((err) => {
        debug('Error:', err.message);
        return null; //Mark as null so it is removed.
      });
    }, {concurrency: 5});
  }).then((docs) => {
    return _.compact(docs); //Remove all the certifications that don't meet the requirements
  }).catch((error) => {
    if (_.get(error, 'response.status') == 404) {
      debug('Certifications resource does not exist.')
      return [];
    } else {
      throw error;
    }
  });
}

module.exports = getDocsForHyperledger;
