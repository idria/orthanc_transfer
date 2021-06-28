process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

var log4js = require("log4js");
var axios = require("axios");
const https = require('https');
const config = require("./config.js");

const ASYNC_JOBS = 5;
var errorCount = 10;

// Create studies queues
var studies = [];
for(let i=0;i<ASYNC_JOBS; i++) {
  if (typeof studies[i] === 'undefined') {
    studies[i] = [];
  }
}

// HTTPS configuration
var httpsConfig = {
  httpsAgent: new https.Agent({
    rejectUnauthorized: false
  }),
  minVersion: "TLSv1.2",
};

// Setup logger
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

// Find studies to send and split into queues
function find(callback) {
  function padLeft(n) {
    return ("00" + n).slice(-2);
  }

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

  let selector = 0;

  axios
    .post(config.orthancUrl + "/tools/find", query, httpsConfig)
    .then(function (resp) {
      for(let i=0;i<resp.data.length;i++) {
        let id,
          accessionNumber,
          studyDate,
          studyInstanceUID,
          patientName,
          patientID = "";

        if (typeof resp.data[i].ID !== "undefined") {
          id = resp.data[i].ID;
        }

        if (typeof resp.data[i].MainDicomTags.AccessionNumber !== "undefined") {
          accessionNumber = resp.data[i].MainDicomTags.AccessionNumber;
        }

        if (typeof resp.data[i].MainDicomTags.StudyDate !== "undefined") {
          studyDate = resp.data[i].MainDicomTags.StudyDate;
        }

        if (typeof resp.data[i].MainDicomTags.StudyInstanceUID !== "undefined") {
          studyInstanceUID = resp.data[i].MainDicomTags.StudyInstanceUID;
        }

        if (typeof resp.data[i].PatientMainDicomTags.PatientName !== "undefined") {
          patientName = resp.data[i].PatientMainDicomTags.PatientName;
        }

        if (typeof resp.data[i].PatientMainDicomTags.PatientID !== "undefined") {
          patientID = resp.data[i].PatientMainDicomTags.PatientID;
        }

        if (resp.data[i].IsStable) {
          studies[selector].push({
            id: id,
            accessionNumber: accessionNumber,
            studyDate: studyDate,
            studyInstanceUID: studyInstanceUID,
            patientName: patientName,
            patientId: patientID,
            jobId: "",
          });

          selector++;
          if (selector == ASYNC_JOBS) {
            selector = 0;
          }
        }
      }

      callback();
    })
    .catch(function (error) {
      // error
      callback(error);
    });
}

function checkOne(queue) {
  setTimeout(function () {

    axios
      .get(config.orthancUrl + "/jobs/" + studies[queue][0].jobId, httpsConfig)
      .then(function (resp) {
        if (resp.data.Progress == 100) {
          logger.info(
            "READY job ID: " +
            studies[queue][0].jobId +
            " patient: " +
            studies[queue][0].patientName +
            " accessionNo: " +
            studies[queue][0].accessionNumber +
            " studyDate: " +
            studies[queue][0].studyDate
          );

          studies[queue].shift();
          sendOne(queue);
        } else {
          checkOne(queue);
        }
      })
      .catch(function (error) {
        logger.error(error);
        if (errorCount) {
          errorCount = errorCount - 1;
          checkOne(queue);
        } else {
          throw error;
        }
      });

  }, 3000);
}

function sendOne(queue) {
  if (studies[queue].length) {

    axios
      .post(config.orthancUrl + "/modalities/" + config.destination + "/store", {
        Asynchronous: true,
        Permissive: true,
        Resources: [studies[queue][0].id],
      }, httpsConfig)
      .then(function (resp) {
        if (typeof resp.data.ID !== "undefined") {
          studies[queue][0].jobId = resp.data.ID;
        }

        logger.info(
          "START job ID: " +
          studies[queue][0].jobId +
          " patient: " +
          studies[queue][0].patientName +
          " accessionNo: " +
          studies[queue][0].accessionNumber +
          " studyDate: " +
          studies[queue][0].studyDate
        );

        checkOne(queue);
      })
      .catch(function (error) {
        logger.error(error);
        if (errorCount) {
          errorCount = errorCount - 1;
          sendOne(queue);
        } else {
          throw error;
        }
      });

  } else {
    logger.info("Nothing to send!");
  }
}

find(function (error) {
  if (error) {
    logger.error(error);
    throw error;
  } else {
    for (let i=0; i < ASYNC_JOBS; i++) {
      sendOne(i);
    }
  }
});
