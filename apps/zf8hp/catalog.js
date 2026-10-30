'use strict';

// Functional GSZFBCE revision 15.000 read schemas; no vehicle readings or OEM binaries.
// Definition: name, field count, byte width, little endian, signed, factor, offset, unit.
const definitions = {
    "4110": ["ADAPTIONSWERTE_GLS_KF1_1_2",64,1,true,true,0.01,0,"bar"],
    "4111": ["ADAPTIONSWERTE_GLS_KF1_2_3",64,1,true,true,0.01,0,"bar"],
    "4112": ["ADAPTIONSWERTE_GLS_KF1_3_4",64,1,true,true,0.01,0,"bar"],
    "4113": ["ADAPTIONSWERTE_GLS_KF1_4_5",64,1,true,true,0.01,0,"bar"],
    "4114": ["ADAPTIONSWERTE_GLS_KF1_5_6",64,1,true,true,0.01,0,"bar"],
    "4115": ["ADAPTIONSWERTE_GLS_KF1_6_7",64,1,true,true,0.01,0,"bar"],
    "4116": ["ADAPTIONSWERTE_GLS_KF1_7_8",64,1,true,true,0.01,0,"bar"],
    "4120": ["ADAPTIONSWERTE_GLS_KF1_5_4",64,1,true,true,0.01,0,"bar"],
    "4121": ["ADAPTIONSWERTE_GLS_KF1_6_5",64,1,true,true,0.01,0,"bar"],
    "4122": ["ADAPTIONSWERTE_GLS_KF1_7_6",64,1,true,true,0.01,0,"bar"],
    "4123": ["ADAPTIONSWERTE_GLS_KF1_8_7",64,1,true,true,0.01,0,"bar"],
    "4124": ["ADAPTIONSWERTE_GLS_KF1_3_1",64,1,false,true,0.01,0,"bar"],
    "4125": ["ADAPTIONSWERTE_GLS_KF1_4_2",64,1,false,true,0.01,0,"bar"],
    "4126": ["ADAPTIONSWERTE_GLS_KF1_5_3",64,1,false,true,0.01,0,"bar"],
    "4127": ["ADAPTIONSWERTE_GLS_KF1_6_4",64,1,false,true,0.01,0,"bar"],
    "4128": ["ADAPTIONSWERTE_GLS_KF1_7_5",64,1,false,true,0.01,0,"bar"],
    "4129": ["ADAPTIONSWERTE_GLS_KF1_8_6",64,1,false,true,0.01,0,"bar"],
    "4130": ["ADAPTIONSWERTE_KSFCTR",5,2,true,false,1,0,""],
    "4131": ["ADAPTIONSWERTE_KPFCTR",5,2,true,false,1,0,""],
    "4133": ["ADAPTIONSWERTE_GLSHSCTRKF1",7,2,true,false,1,0,""],
    "4134": ["ADAPTIONSWERTE_GLSRSCTRKF1",18,2,true,false,1,0,""],
    "4136": ["ADAPTIONSWERTE_GLSHSCTRKF2",7,2,true,false,1,0,""],
    "4137": ["ADAPTIONSWERTE_GLSRSCTRKF2",7,2,true,false,1,0,""],
    "4140": ["ADAPTIONSWERTE_KSF",5,2,true,true,1,0,"ms"],
    "4143": ["ADAPTIONSWERTE_BFLGLSKF1",25,2,true,true,1,0,"mbar"],
    "4144": ["ADAPTIONSWERTE_BFLGLSKF2",25,2,true,true,1,0,"mbar"],
    "4160": ["ADAPTIONSWERTE_GLS_KF2_1_2",64,1,true,true,0.01,0,"bar"],
    "4161": ["ADAPTIONSWERTE_GLS_KF2_2_3",64,1,true,true,0.01,0,"bar"],
    "4162": ["ADAPTIONSWERTE_GLS_KF2_3_4",64,1,true,true,0.01,0,"bar"],
    "4163": ["ADAPTIONSWERTE_GLS_KF2_4_5",64,1,true,true,0.01,0,"bar"],
    "4164": ["ADAPTIONSWERTE_GLS_KF2_5_6",64,1,true,true,0.01,0,"bar"],
    "4165": ["ADAPTIONSWERTE_GLS_KF2_6_7",64,1,true,true,0.01,0,"bar"],
    "4166": ["ADAPTIONSWERTE_GLS_KF2_7_8",64,1,true,true,0.01,0,"bar"],
    "4170": ["ADAPTIONSWERTE_GLS_KF2_5_4",64,1,true,true,0.01,0,"bar"],
    "4171": ["ADAPTIONSWERTE_GLS_KF2_6_5",64,1,true,true,0.01,0,"bar"],
    "4172": ["ADAPTIONSWERTE_GLS_KF2_7_6",64,1,true,true,0.01,0,"bar"],
    "4173": ["ADAPTIONSWERTE_GLS_KF2_8_7",64,1,true,true,0.01,0,"bar"],
    "4187": ["ADAGLS_BEEINF_KF1_KALT_MEM_ID",7,2,true,true,1,0,""],
    "4188": ["ADAGLS_BEEINF_KF2_KALT_MEM_ID",7,2,true,true,1,0,""],
    "4189": ["ADAKPFCTR_KALT_MEM_ID",5,2,true,false,1,0,""],
    "4440": ["SUBSTRATTEMPERATURKOLLEKTIV",23,4,false,false,1,0,"s"],
    "4441": ["OELTEMPERATURKOLLEKTIV",23,4,false,false,1,0,"s"],
    "4800": ["documented EGS histogram",0],
    "4801": ["documented EGS histogram",0],
    "4802": ["documented EGS histogram",0],
    "4803": ["documented EGS histogram",0],
    "4804": ["documented EGS histogram",0],
    "4805": ["documented EGS histogram",0],
    "4806": ["documented EGS histogram",0],
    "4807": ["documented EGS histogram",0],
    "4808": ["documented EGS histogram",0],
    "4809": ["documented EGS histogram",0],
    "6000": ["_GETRIEBEOELTEMPERATUR",1,1,false,false,1,-40,"°C"],
    "6003": ["_SYSTEMZEIT_ZF",1,4,false,true,1,0,"s"],
    "6005": ["_CHIP1_TEMPERATUR",1,1,false,false,1,-40,"°C"],
    "6008": ["_ABTRIEBSDREHZAHL",1,1,false,false,32,0,"1/min"],
    "6009": ["_TURBINENDREHZAHL",1,1,false,false,32,0,"1/min"],
    "6031": ["_MOTORMOMENT",1,1,false,true,4,-100,"Nm"],
    "6081": ["_BETRIEBSZEIT_DER_EGS_OHNE_STANDBY",1,4,false,true,1,0,"min"],
    "6090": ["_ANZAHL_DER_AUSGEFUEHRTEN_STANDADAPTIONEN",1,1,false,false,1,0,""],
    "411D": ["ADAPTIONSWERTE_GLS_KF1_2_1",64,1,true,true,0.01,0,"bar"],
    "411E": ["ADAPTIONSWERTE_GLS_KF1_3_2",64,1,true,true,0.01,0,"bar"],
    "411F": ["ADAPTIONSWERTE_GLS_KF1_4_3",64,1,true,true,0.01,0,"bar"],
    "412A": ["ADAPTIONSWERTE_GLS_KF1_5_1",24,1,false,true,0.01,0,"bar"],
    "412B": ["ADAPTIONSWERTE_GLS_KF1_6_3",24,1,false,true,0.01,0,"bar"],
    "412C": ["ADAPTIONSWERTE_GLS_KF1_7_1",24,1,false,true,0.01,0,"bar"],
    "412D": ["ADAPTIONSWERTE_GLS_KF1_8_2",24,1,false,true,0.01,0,"bar"],
    "412E": ["ADAPTIONSWERTE_GLS_KF1_8_4",24,1,false,true,0.01,0,"bar"],
    "412F": ["ADAPTIONSWERTE_GE",3,2,true,true,1,0,"mbar"],
    "413A": ["ADAPTIONSWERTE_KPF",5,2,true,true,1,0,"mbar"],
    "415F": ["GANG_EINLEGE_ADAPTION_CTR",3,2,true,false,1,0,""],
    "416D": ["ADAPTIONSWERTE_GLS_KF2_2_1",64,1,true,true,0.01,0,"bar"],
    "416E": ["ADAPTIONSWERTE_GLS_KF2_3_2",64,1,true,true,0.01,0,"bar"],
    "416F": ["ADAPTIONSWERTE_GLS_KF2_4_3",64,1,true,true,0.01,0,"bar"],
    "418A": ["ADAKPF_KALT_MEM_ID",5,2,true,true,1,0,""],
    "418B": ["ADAKPF_SHCTR_KALT_MEM_ID",5,2,true,false,1,0,""],
    "418C": ["ADAKPF_START_CTR_MEM_ID",5,2,true,false,1,0,""],
    "41A0": ["ADAPTIONSWERTE_TSF_WK_AUSLESEN",1,2,true,true,10,0,"ms"],
    "41A1": ["ADAPTION_WK_TSF_CTR_AUSLESEN",1,2,true,false,1,0,""],
    "41B0": ["GANGAUSLEGE_ADAPT_SPEICHER",3,2,true,true,1,0,"mbar"],
    "41B1": ["GANGAUSLEGE_ADAPT_SPEICHER_CTR",3,2,true,false,1,0,""],
    "41B3": ["FUSSPUNKT_ADAPTIONSWERT_WK",1,2,true,true,1,0,"mA"],
    "41B4": ["FUSSPUNKT_ADAPTWERT_WK_CTR",1,2,true,false,1,0,""],
    "41B6": ["GLS_ADAP_EHS_KF1_KALT",448,1,true,true,10,0,"mbar"],
    "41B7": ["GLS_ADAP_EHS_KF2_KALT",448,1,true,true,10,0,"mbar"],
    "41B9": ["GLS_ADAP_EHS_KF1_KALT_CTR",7,2,true,false,1,0,""],
    "41BA": ["GLS_ADAP_EHS_KF2_KALT_CTR",7,2,true,false,1,0,""],
    "600A": ["_MOTORDREHZAHL_ZF",1,1,false,false,32,0,"1/min"],
    "600B": ["_MOTOR_ISTMOMENT",1,1,false,false,4,0,"Nm"],
    "600C": ["_AKTUELLER_GANG",1,1,false,false,1,0,"0-n"],
    "601D": ["_CHIP2_TEMPERATUR",1,1,false,false,1,-40,"°C"],
    "602E": ["_ANZEIGE_IST_UND_ZIELGANG",0],
    "602F": ["_WANDLERUEBERBRUECKUNGSKUPPLUNG_UND_SEGELZUSTAND_GETRIEBE",0],
    "61F8": ["_LOGIK_ELEKTRISCHE_DRUCKSTEUERVENTILE_GESCHALTETE_KUPPLUNGEN",0],
    "DA22": ["WANDLERKUPPLUNG",1,2,false,true,1,0,"0-n"],
    "DA2A": ["EINAUSGANG_DREHZAHL",2,2,false,true,1,0,"1/min"],
    "DA2E": ["ISTGANG",2,1,false,false,1,0,"0-n"],
    "DA34": ["MOTORDREHZAHL",1,2,false,false,1,0,"U/min"],
    "DB03": ["OIL_LEVEL_TEMP",2,1,false,false,1,-40,"°C"],
    "DB04": ["OIL_LEVEL_RPM",2,2,false,false,1,0,"1/m"],
    "480F": ["documented EGS histogram",0],
    "480A": ["documented EGS histogram",0],
    "F101": ["SOFTWARE_COMPONENT_IDENTIFICATION",0],
    "480D": ["documented EGS histogram",0],
    "480E": ["documented EGS histogram",0],
    "480B": ["documented EGS histogram",0],
    "480C": ["documented EGS histogram",0],
    "F150": ["SGBD_IDENTIFICATION",0]
};

const records = {};
Object.keys(definitions).forEach((id) => {
    const d = definitions[id];
    records[id] = { name: d[0], length: d[1] ? d[1] * d[2] : null,
        fields: Array.from({ length: d[1] }, (_, i) => ({ at: i * d[2], bytes: d[2], little: d[3],
            signed: d[4], factor: d[5], offset: d[6], unit: d[7] })) };
});

module.exports = Object.assign({ records }, {
    "ranges": [
        "-40..-20",
        "-19..0",
        "1..20",
        "21..40",
        "41..60",
        "61..70",
        "71..80",
        "81..90",
        "91..95",
        "96..100",
        "101..105",
        "106..110",
        "111..115",
        "116..120",
        "121..125",
        "126..130",
        "131..135",
        "136..140",
        "141..145",
        "146..150",
        "151..155",
        "156..160",
        ">160"
    ],
    "shifts": [
        {
            "did": "4110",
            "family": 1,
            "fromGear": 1,
            "toGear": 2,
            "label": "1 > 2"
        },
        {
            "did": "4111",
            "family": 1,
            "fromGear": 2,
            "toGear": 3,
            "label": "2 > 3"
        },
        {
            "did": "4112",
            "family": 1,
            "fromGear": 3,
            "toGear": 4,
            "label": "3 > 4"
        },
        {
            "did": "4113",
            "family": 1,
            "fromGear": 4,
            "toGear": 5,
            "label": "4 > 5"
        },
        {
            "did": "4114",
            "family": 1,
            "fromGear": 5,
            "toGear": 6,
            "label": "5 > 6"
        },
        {
            "did": "4115",
            "family": 1,
            "fromGear": 6,
            "toGear": 7,
            "label": "6 > 7"
        },
        {
            "did": "4116",
            "family": 1,
            "fromGear": 7,
            "toGear": 8,
            "label": "7 > 8"
        },
        {
            "did": "411D",
            "family": 1,
            "fromGear": 2,
            "toGear": 1,
            "label": "2 > 1"
        },
        {
            "did": "411E",
            "family": 1,
            "fromGear": 3,
            "toGear": 2,
            "label": "3 > 2"
        },
        {
            "did": "411F",
            "family": 1,
            "fromGear": 4,
            "toGear": 3,
            "label": "4 > 3"
        },
        {
            "did": "4120",
            "family": 1,
            "fromGear": 5,
            "toGear": 4,
            "label": "5 > 4"
        },
        {
            "did": "4121",
            "family": 1,
            "fromGear": 6,
            "toGear": 5,
            "label": "6 > 5"
        },
        {
            "did": "4122",
            "family": 1,
            "fromGear": 7,
            "toGear": 6,
            "label": "7 > 6"
        },
        {
            "did": "4123",
            "family": 1,
            "fromGear": 8,
            "toGear": 7,
            "label": "8 > 7"
        },
        {
            "did": "4124",
            "family": 1,
            "fromGear": 3,
            "toGear": 1,
            "label": "3 > 1"
        },
        {
            "did": "4125",
            "family": 1,
            "fromGear": 4,
            "toGear": 2,
            "label": "4 > 2"
        },
        {
            "did": "4126",
            "family": 1,
            "fromGear": 5,
            "toGear": 3,
            "label": "5 > 3"
        },
        {
            "did": "4127",
            "family": 1,
            "fromGear": 6,
            "toGear": 4,
            "label": "6 > 4"
        },
        {
            "did": "4128",
            "family": 1,
            "fromGear": 7,
            "toGear": 5,
            "label": "7 > 5"
        },
        {
            "did": "4129",
            "family": 1,
            "fromGear": 8,
            "toGear": 6,
            "label": "8 > 6"
        },
        {
            "did": "412A",
            "family": 1,
            "fromGear": 5,
            "toGear": 1,
            "label": "5 > 1"
        },
        {
            "did": "412B",
            "family": 1,
            "fromGear": 6,
            "toGear": 3,
            "label": "6 > 3"
        },
        {
            "did": "412C",
            "family": 1,
            "fromGear": 7,
            "toGear": 1,
            "label": "7 > 1"
        },
        {
            "did": "412D",
            "family": 1,
            "fromGear": 8,
            "toGear": 2,
            "label": "8 > 2"
        },
        {
            "did": "412E",
            "family": 1,
            "fromGear": 8,
            "toGear": 4,
            "label": "8 > 4"
        },
        {
            "did": "4160",
            "family": 2,
            "fromGear": 1,
            "toGear": 2,
            "label": "1 > 2"
        },
        {
            "did": "4161",
            "family": 2,
            "fromGear": 2,
            "toGear": 3,
            "label": "2 > 3"
        },
        {
            "did": "4162",
            "family": 2,
            "fromGear": 3,
            "toGear": 4,
            "label": "3 > 4"
        },
        {
            "did": "4163",
            "family": 2,
            "fromGear": 4,
            "toGear": 5,
            "label": "4 > 5"
        },
        {
            "did": "4164",
            "family": 2,
            "fromGear": 5,
            "toGear": 6,
            "label": "5 > 6"
        },
        {
            "did": "4165",
            "family": 2,
            "fromGear": 6,
            "toGear": 7,
            "label": "6 > 7"
        },
        {
            "did": "4166",
            "family": 2,
            "fromGear": 7,
            "toGear": 8,
            "label": "7 > 8"
        },
        {
            "did": "416D",
            "family": 2,
            "fromGear": 2,
            "toGear": 1,
            "label": "2 > 1"
        },
        {
            "did": "416E",
            "family": 2,
            "fromGear": 3,
            "toGear": 2,
            "label": "3 > 2"
        },
        {
            "did": "416F",
            "family": 2,
            "fromGear": 4,
            "toGear": 3,
            "label": "4 > 3"
        },
        {
            "did": "4170",
            "family": 2,
            "fromGear": 5,
            "toGear": 4,
            "label": "5 > 4"
        },
        {
            "did": "4171",
            "family": 2,
            "fromGear": 6,
            "toGear": 5,
            "label": "6 > 5"
        },
        {
            "did": "4172",
            "family": 2,
            "fromGear": 7,
            "toGear": 6,
            "label": "7 > 6"
        },
        {
            "did": "4173",
            "family": 2,
            "fromGear": 8,
            "toGear": 7,
            "label": "8 > 7"
        }
    ],
    "gearNames": {
        "0": "P",
        "1": "R",
        "2": "N",
        "3": "1",
        "4": "2",
        "5": "3",
        "6": "4",
        "7": "5",
        "8": "6",
        "9": "7",
        "16": "8"
    },
    "selectorNames": {
        "0": "P",
        "1": "R",
        "2": "N",
        "3": "D",
        "4": "M"
    },
    "clutchMatrix": {
        "1": "ABC",
        "2": "ABE",
        "3": "BCE",
        "4": "BDE",
        "5": "BCD",
        "6": "CDE",
        "7": "ACD",
        "8": "ADE",
        "R": "ABD"
    }
});
