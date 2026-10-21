MGU custom apps - head unit kit
================================

What it does
------------
Installs the custom apps (apps/*.mgu) on a BMW MGU (ID7) head unit so they
show up under Apps and survive reboots. Everything is backed up first and can
be put back with one command.

Before you start
----------------
* Car parked, ignition on / head unit awake, a stable 12 V supply (charger or
  engine running) - the platform restarts once (screen reloads ~1-2 min).
* Root shell on the head unit (SSH or serial).
* This folder on the unit: USB stick, or from the PC:
      HU=root@<unit-ip> PORT=<port> deploy/push-to-car.sh check

Steps (run on the head unit, as root, inside this folder)
--------------------------------------------------------
1.  sh deploy-car.sh check
        Changes nothing. Checks the unit, test-builds the MainApp patch for
        THIS firmware and lists every file that would be touched.
        If it says "MainApp ... a version the patch does not know": stop.

2.  sh deploy-car.sh install
        a) backs up every file it will touch into ./backups/<time>/ AND
           /var/opt/public/mgu_custom_backup/<time>/, verifies the backup and
           stops if anything is wrong. The very first backup is kept as the
           "stock" backup and is never overwritten.
        b) enables the provisioning hook persistently (see below)
        c) installs / updates every apps/*.mgu
        d) restarts the app platform once and prints what is installed
    Run it again later with new .mgu files to update - it makes a new backup
    each time; the stock one stays.

3.  Check the car: Apps menu -> the new tiles. Logs per app:
        /var/opt/public/oap/oap_<uid>/data/<app>.log
    sh deploy-car.sh status

Back to stock
-------------
    sh deploy-car.sh restore            (asks you to type YES)
    YES=1 sh deploy-car.sh restore      (no question)
    sh deploy-car.sh restore <backup>   (a specific one, see: sh deploy-car.sh backups)
Stops the platform, removes the hook and the installed apps, copies every
touched file back exactly as it was in the stock backup, checks each file
against the backup, restarts the HMI (screen goes black for up to a minute -
this clears the removed apps' tiles without a reboot; skip it with
NO_HMI_RESTART=1) and starts the platform again.
A BMW app that the platform itself installed after the backup (not one of
ours) is left installed and stays registered.

Files it touches
----------------
  /var/opt/public/oap/oap_12201/security/uids.txt        app id list
  /var/opt/public/oap/oap_12201/data/apps/               app registry
  /var/opt/public/oap/oap_12201/data/custom_apps.json    (new) our app list
  /var/opt/public/oap/_mgu_custom/                       (new) patched main.js + boot script
  /etc/systemd/system/oapcontroller.service.d/50-mgu-custom-apps.conf   (new)
  /var/opt/public/oap/oap_12221.. oap_12299/             (new) the apps

The provisioning hook (why it is needed)
----------------------------------------
MainApp only shows apps that BMW's signed provisioning data lists as enabled;
custom apps are not in it, so MainApp would hide them. The kit makes a copy of
MainApp's main.js with ONE fallback added ("if the provisioning data has no
entry for an app, use its entry from custom_apps.json") and bind-mounts that
copy over the original when the app platform starts. The original file on the
read-only system partition is never modified.
After a firmware update the boot script sees that MainApp changed and does NOT
apply the old copy (MainApp runs stock, the custom apps are just hidden). Run
"sh deploy-car.sh install" again to re-create the hook for the new firmware.

Things to know
--------------
* An app that crashes repeatedly is removed by MainApp itself (1st crash: its
  data folder is wiped, 2nd: it is uninstalled). Re-run install to bring it back.
* Never kill an app process by hand for the same reason; the installer restarts
  the platform instead.
* BMW's own apps are never modified (the installer refuses uids below 12221).
