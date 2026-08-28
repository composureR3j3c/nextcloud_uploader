const fs = require('fs');

const {
  findUserByEmail,
  uploadToAdmin,
  shareWithUser,
  uploadToUserDrive,
  whoAmI,
} = require('./nextcloud.service');


async function uploadToUser(req, res) {

  console.log('\n\n');
  console.log('########################################');
  console.log('# NEW NEXTCLOUD UPLOAD REQUEST');
  console.log('########################################');

  let file = req.file;

  try {

    const email =
      req.body.email;

    console.log(
      '[REQUEST] Email:',
      email
    );

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'email is required',
      });
    }

    if (!file) {
      return res.status(400).json({
        success: false,
        message: 'file is required',
      });
    }

    console.log(
      '[REQUEST] File:',
      file.originalname
    );


    /*
     * 1. FIND USER
     */

    const targetUser =
      await findUserByEmail(email);

    if (!targetUser) {

      return res.status(404).json({
        success: false,
        message:
          'No Nextcloud user found matching email',
        email,
      });
    }

    /*
     * 2. VERIFY EMAIL
     */

    const requestedEmail =
      email.trim().toLowerCase();

    const actualEmail =
      String(targetUser.email || '')
        .trim()
        .toLowerCase();

    if (
      requestedEmail !==
      actualEmail
    ) {

      return res.status(409).json({
        success: false,
        message:
          'Email verification failed',
      });
    }

    /*
     * 3. UPLOAD TO ADMIN
     */

    const upload =
      await uploadToAdmin(
        file.path,
        file.originalname
      );

    /*
     * 4. SHARE WITH MATCHED USER
     */

    const share =
      await shareWithUser(
        upload.remotePath,
        targetUser.id
      );

    /*
     * 5. SUCCESS
     */

    console.log('\n');
    console.log(
      '########################################'
    );

    console.log(
      '# COMPLETE SUCCESS'
    );

    console.log(
      '########################################'
    );

    return res.status(201).json({

      success: true,

      user: {
        id: targetUser.id,
        email: targetUser.email,
        displayName:
          targetUser.displayname ||
          targetUser['display-name'] ||
          null,
      },

      file: {
        originalName:
          file.originalname,

        name:
          upload.remoteFileName,

        path:
          upload.remotePath,
      },

      share: {
        id:
          share.id || null,

        permissions:
          31,
      },
    });

  } catch (error) {

    console.error(
      '[REQUEST] FAILED:',
      error.message
    );

    if (error.response) {

      console.error(
        '[REQUEST] HTTP:',
        error.response.status
      );

      console.error(
        '[REQUEST] Response:',
        error.response.data
      );
    }

    return res.status(500).json({
      success: false,
      message:
        'Nextcloud operation failed',
      error:
        error.response?.data ||
        error.message,
    });

  } finally {

    if (file?.path) {

      try {

        fs.unlinkSync(file.path);

        console.log(
          '[CLEANUP] Temporary file deleted'
        );

      } catch (error) {

        console.warn(
          '[CLEANUP] Failed:',
          error.message
        );
      }
    }
  }
}


async function uploadToMyDrive(req, res) {

  console.log('\n\n');
  console.log('########################################');
  console.log('# NEW NEXTCLOUD UPLOAD-TO-DRIVE REQUEST');
  console.log('########################################');

  let file = req.file;

  try {

    const nextcloudAuth =
      req.nextcloudAuth;

    console.log(
      '[REQUEST] Basic auth username:',
      nextcloudAuth?.username
    );

    if (!file) {
      return res.status(400).json({
        success: false,
        message: 'file is required',
      });
    }

    console.log(
      '[REQUEST] File:',
      file.originalname
    );

    /*
     * 1. AUTHENTICATE TO NEXTCLOUD USING THE
     *    CALLER-SUPPLIED BASIC AUTH CREDENTIALS
     */

    const authenticatedUser =
      await whoAmI(nextcloudAuth);

    /*
     * 2. OPTIONAL EMAIL CROSS-CHECK
     */

    const email =
      req.body.email;

    if (email) {

      const requestedEmail =
        email.trim().toLowerCase();

      const actualEmail =
        String(authenticatedUser.email || '')
          .trim()
          .toLowerCase();

      if (
        requestedEmail !==
        actualEmail
      ) {

        return res.status(409).json({
          success: false,
          message:
            'Email does not match the authenticated Nextcloud account',
        });
      }
    }

    /*
     * 3. UPLOAD DIRECTLY TO THE AUTHENTICATED
     *    USER'S OWN DRIVE, USING THEIR OWN
     *    BASIC AUTH CREDENTIALS
     */

    const upload =
      await uploadToUserDrive(
        file.path,
        file.originalname,
        authenticatedUser.id,
        file.mimetype,
        nextcloudAuth
      );

    /*
     * 4. SUCCESS
     */

    console.log('\n');
    console.log(
      '########################################'
    );

    console.log(
      '# COMPLETE SUCCESS'
    );

    console.log(
      '########################################'
    );

    return res.status(201).json({

      success: true,

      user: {
        id: authenticatedUser.id,
        email: authenticatedUser.email,
        displayName:
          authenticatedUser.displayname ||
          authenticatedUser['display-name'] ||
          null,
      },

      file: {
        originalName:
          file.originalname,

        name:
          upload.remoteFileName,

        path:
          upload.remotePath,
      },
    });

  } catch (error) {

    console.error(
      '[REQUEST] FAILED:',
      error.message
    );

    if (error.response) {

      console.error(
        '[REQUEST] HTTP:',
        error.response.status
      );

      console.error(
        '[REQUEST] Response:',
        error.response.data
      );
    }

    if (error.response?.status === 401) {

      return res.status(401).json({
        success: false,
        message:
          'Invalid Nextcloud credentials',
      });
    }

    return res.status(500).json({
      success: false,
      message:
        'Nextcloud operation failed',
      error:
        error.response?.data ||
        error.message,
    });

  } finally {

    if (file?.path) {

      try {

        fs.unlinkSync(file.path);

        console.log(
          '[CLEANUP] Temporary file deleted'
        );

      } catch (error) {

        console.warn(
          '[CLEANUP] Failed:',
          error.message
        );
      }
    }
  }
}


module.exports = {
  uploadToUser,
  uploadToMyDrive,
};