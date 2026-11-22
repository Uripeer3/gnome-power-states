// SPDX-License-Identifier: GPL-3.0-or-later
// Self-contained minimal D-Bus introspection XML definitions used by both
// extension.js and prefs.js without depending on private Shell resources.

export const UPOWER_XML = `
<node>
  <interface name="org.freedesktop.UPower">
    <method name="EnumerateDevices">
      <arg type="ao" direction="out" name="devices"/>
    </method>
    <signal name="DeviceAdded">
      <arg type="o" name="device"/>
    </signal>
    <signal name="DeviceRemoved">
      <arg type="o" name="device"/>
    </signal>
    <property name="OnBattery" type="b" access="read"/>
    <property name="LidIsClosed" type="b" access="read"/>
    <property name="LidIsPresent" type="b" access="read"/>
  </interface>
</node>`;

export const UPOWER_DEVICE_XML = `
<node>
  <interface name="org.freedesktop.UPower.Device">
    <property name="Type" type="u" access="read"/>
    <property name="Online" type="b" access="read"/>
    <property name="State" type="u" access="read"/>
    <property name="Percentage" type="d" access="read"/>
    <property name="WarningLevel" type="u" access="read"/>
    <property name="IsPresent" type="b" access="read"/>
  </interface>
</node>`;

export const POWER_PROFILES_BUS_CANDIDATES = Object.freeze([
    {
        busName: 'org.freedesktop.UPower.PowerProfiles',
        objectPath: '/org/freedesktop/UPower/PowerProfiles',
        interfaceName: 'org.freedesktop.UPower.PowerProfiles',
    },
    {
        busName: 'net.hadess.PowerProfiles',
        objectPath: '/net/hadess/PowerProfiles',
        interfaceName: 'net.hadess.PowerProfiles',
    },
]);

export function makePowerProfilesXml(interfaceName) {
    return `
<node>
  <interface name="${interfaceName}">
    <property name="ActiveProfile" type="s" access="readwrite"/>
    <property name="PerformanceDegraded" type="s" access="read"/>
    <property name="Profiles" type="aa{sv}" access="read"/>
    <property name="ActiveProfileHolds" type="aa{sv}" access="read"/>
  </interface>
</node>`;
}

export const LOGIN1_MANAGER_XML = `
<node>
  <interface name="org.freedesktop.login1.Manager">
    <method name="GetSession">
      <arg type="s" direction="in" name="session_id"/>
      <arg type="o" direction="out" name="session"/>
    </method>
    <method name="GetSessionByPID">
      <arg type="u" direction="in" name="pid"/>
      <arg type="o" direction="out" name="session"/>
    </method>
    <method name="CanSuspend">
      <arg type="s" direction="out" name="result"/>
    </method>
    <method name="CanHibernate">
      <arg type="s" direction="out" name="result"/>
    </method>
    <method name="CanHybridSleep">
      <arg type="s" direction="out" name="result"/>
    </method>
    <method name="CanSuspendThenHibernate">
      <arg type="s" direction="out" name="result"/>
    </method>
    <method name="Suspend">
      <arg type="b" direction="in" name="interactive"/>
    </method>
    <method name="Hibernate">
      <arg type="b" direction="in" name="interactive"/>
    </method>
    <method name="HybridSleep">
      <arg type="b" direction="in" name="interactive"/>
    </method>
    <method name="SuspendThenHibernate">
      <arg type="b" direction="in" name="interactive"/>
    </method>
    <signal name="PrepareForSleep">
      <arg type="b" name="start"/>
    </signal>
    <property name="LidClosed" type="b" access="read"/>
    <property name="Docked" type="b" access="read"/>
  </interface>
</node>`;

export const LOGIN1_SESSION_XML = `
<node>
  <interface name="org.freedesktop.login1.Session">
    <property name="Active" type="b" access="read"/>
  </interface>
</node>`;

export const LOGIN1_USER_XML = `
<node>
  <interface name="org.freedesktop.login1.User">
    <property name="Display" type="(so)" access="read"/>
  </interface>
</node>`;

export const SCREENSAVER_XML = `
<node>
  <interface name="org.gnome.ScreenSaver">
    <method name="Lock"/>
    <method name="SetActive">
      <arg type="b" direction="in" name="value"/>
    </method>
  </interface>
</node>`;

export const DISPLAY_CONFIG_XML = `
<node>
  <interface name="org.gnome.Mutter.DisplayConfig">
    <method name="GetCurrentState">
      <arg name="serial" type="u" direction="out"/>
      <arg name="monitors" type="a((ssss)a(siiddada{sv})a{sv})" direction="out"/>
      <arg name="logical_monitors" type="a(iiduba(ssss)a{sv})" direction="out"/>
      <arg name="properties" type="a{sv}" direction="out"/>
    </method>
    <signal name="MonitorsChanged"/>
    <property name="PowerSaveMode" type="i" access="readwrite"/>
  </interface>
</node>`;
