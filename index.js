process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

var log4js = require("log4js");
var axios = require("axios");
const https = require('https');

const config = require("./config.js");

var errorCount = 10;
var studies = [];

function padLeft(n) {
  return ("00" + n).slice(-2);
}

// logger
log4js.configure({
  appenders: {
    everything: {
      type: "file",
      filename: "logs/main.log",
      maxLogSize: 10485760,
      backups: 3,
      compress: true,
    },
  },
  categories: {
    default: {
      appenders: ["everything"],
      level: "debug",
    },
  },
});

const logger = log4js.getLogger();
logger.info("Orthanc transfer running.");

// find studies to send
function find(callback) {
  var d = new Date();
  d.setDate(d.getDate() - config.prevDays);

  let dicomDate =
    d.getFullYear() + padLeft(d.getMonth() + 1) + padLeft(d.getDate());
  logger.info("Query from " + dicomDate + ".");

  let query = {
    Level: "Study",
    Query: {
      ModalitiesInStudy: config.modality,
      StudyDate: dicomDate + "-",
    },
    Expand: true,
  };

  axios
    .post(config.orthancUrl + "/tools/find", query, {
      httpsAgent: new https.Agent({
          rejectUnauthorized: false
      })
    })
    .then(function (response) {
      // save response
      response.data.forEach((p) => {
        let id,
          accessionNumber,
          studyDate,
          studyInstanceUID,
          patientName,
          patientID = "";

        if (typeof p.ID !== "undefined") {
          id = p.ID;
        }

        if (typeof p.MainDicomTags.AccessionNumber !== "undefined") {
          accessionNumber = p.MainDicomTags.AccessionNumber;
        }

        if (typeof p.MainDicomTags.StudyDate !== "undefined") {
          studyDate = p.MainDicomTags.StudyDate;
        }

        if (typeof p.MainDicomTags.StudyInstanceUID !== "undefined") {
          studyInstanceUID = p.MainDicomTags.StudyInstanceUID;
        }

        if (typeof p.PatientMainDicomTags.PatientName !== "undefined") {
          patientName = p.PatientMainDicomTags.PatientName;
        }

        if (typeof p.PatientMainDicomTags.PatientID !== "undefined") {
          patientID = p.PatientMainDicomTags.PatientID;
        }

        if (p.IsStable) {
          studies.push({
            id: id,
            accessionNumber: accessionNumber,
            studyDate: studyDate,
            studyInstanceUID: studyInstanceUID,
            patientName: patientName,
            patientId: patientID,
            jobId: "",
          });
        }
      });

      // continue
      callback();
    })
    .catch(function (error) {
      // error
      callback(error);
    });
}

function checkOne() {
  setTimeout(function() {

    axios
      .get(config.orthancUrl + "/jobs/" + studies[0].jobId, {
        httpsAgent: new https.Agent({
            rejectUnauthorized: false
        })
      })
      .then(function (response) {
        if (response.data.Progress == 100) {
          logger.info(
            "READY job ID: " +
              studies[0].jobId +
              " patient: " +
              studies[0].patientName +
              " accessionNo: " +
              studies[0].accessionNumber +
              " studyDate: " +
              studies[0].studyDate
          );
          
          studies.shift();
          sendOne();
        } else {
          checkOne();
        }
      })
      .catch(function (error) {
        logger.error(error);
        if (errorCount) {
          errorCount = errorCount-1;
          checkOne();
        } else {
          throw error;
        }
      });

  }, 3000);
}

function sendOne() {
  if (studies.length) {

    axios
      .post(config.orthancUrl + "/modalities/" + config.destination + "/store", {
        Asynchronous: true,
        Permissive: true,
        Resources: [studies[0].id],
        httpsAgent: new https.Agent({
          rejectUnauthorized: false
        })
      })
      .then(function (response) {
        if (typeof response.data.ID !== "undefined") {
          studies[0].jobId = response.data.ID;
        }

        logger.info(
          "START job ID: " +
            studies[0].jobId +
            " patient: " +
            studies[0].patientName +
            " accessionNo: " +
            studies[0].accessionNumber +
            " studyDate: " +
            studies[0].studyDate
        );

        checkOne();
      })
      .catch(function (error) {
        logger.error(error);
        if (errorCount) {
          errorCount = errorCount-1;
          sendOne();
        } else {
          throw error;
        }
      });

  } else {
    logger.info("Nothing to send!");
  }
}

find(function(error) {
  if (error) {
    logger.error(error);
    throw error;
  } else {
    sendOne();
  }
});
