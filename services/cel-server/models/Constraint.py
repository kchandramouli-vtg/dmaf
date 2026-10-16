import xml.etree.ElementTree as ET
from typing import Dict, List

from pydantic.main import BaseModel

from models.FactIntersection import FactIntersection
from models.SpatialLocation import SpatialLocation
from models.TemporalInterval import TemporalInterval

# =============================================================================
# Constraint
# =============================================================================


class Constraint(BaseModel):
    namespace: Dict[str, str] = {}
    data: str = ''
    beforeDate: str = ''
    afterDate: str = ''
    accessPolicy: str = ''
    deliveryModality: str = ''  # orn
    runs: str = ''
    language: str = ''
    isExclusive: str = ''
    means: str = ''
    constraintList: List[str] = ['copyrightExceptionFact', 'accessPolicy', 'deliveryModality', 'device', 'means', 'serviceAccessPolicy', 'userTimeAccess', 'temporalInterval',
                                 'spatialLocation', 'runs', 'language', 'hasIncomePercentage', 'hasUsePercentage', 'isExclusive', 'hasSublicenseRight', 'length', 'IPEntityContext']
    factIntersection: FactIntersection = None
    factUnion: FactIntersection = None
    factNegation: FactIntersection = None
    spatialLocation: SpatialLocation = None

    def parse(self):
        constraint = ET.fromstring(self.data)
        t = constraint.find('cel-ipre:temporalInterval', self.namespace)
        if t is not None:  # DMAF: Element truthiness is len(children)
            time1 = TemporalInterval(
                **{'data': ET.tostring(t), 'namespace': self.namespace})
            time1.parse()
            self.beforeDate = time1.beforeDate
            self.afterDate = time1.afterDate
        factIntersection = constraint.find(
            'cel-core:factIntersection', self.namespace)
        if factIntersection is not None:  # DMAF: Element truthiness is len(children)
            self.factIntersection = FactIntersection(
                **{'data': ET.tostring(factIntersection), 'namespace': self.namespace})
            self.factIntersection.parse()
        factUnion = constraint.find('cel-core:factUnion', self.namespace)
        if factUnion is not None:  # DMAF: Element truthiness is len(children)
            self.factUnion = FactIntersection(
                **{'data': ET.tostring(factUnion), 'namespace': self.namespace})
            self.factUnion.parse()
        factNegation = constraint.find('cel-core:factNegation', self.namespace)
        if factNegation is not None:  # DMAF: Element truthiness is len(children)
            self.factNegation = FactIntersection(
                **{'data': ET.tostring(factNegation), 'namespace': self.namespace})
            self.factNegation.parse()

        accessPolicy = constraint.find('cel-ipre:AccessPolicy', self.namespace)
        if accessPolicy is not None:  # DMAF: Element truthiness is len(children)
            attrib = accessPolicy.attrib
            if 'access' in attrib:
                self.accessPolicy = accessPolicy.attrib['access']

        deliveryModality = constraint.find(
            'cel-ipre:DeliveryModality', self.namespace)
        if deliveryModality is not None:  # DMAF: Element truthiness is len(children)
            attrib = deliveryModality.attrib
            if 'mod' in attrib:
                self.deliveryModality = deliveryModality.attrib['mod']
            if 'href' in attrib:
                self.deliveryModality = deliveryModality.attrib['href']

        runs = constraint.find('cel-ipre:Runs', self.namespace)
        if runs is not None:  # DMAF: Element truthiness is len(children)
            attrib = runs.attrib
            if 'number' in attrib:  # DMAF: was `in runs` (children), never true
                self.runs = runs.attrib['number']

        language = constraint.find('cel-ipre:Language', self.namespace)
        if language is not None:  # DMAF: Element truthiness is len(children)
            attrib = language.attrib
            if 'lang' in attrib:
                self.language = language.attrib['lang']

        isExclusive = constraint.find('cel-ipre:isExclusive', self.namespace)
        if isExclusive is not None:  # DMAF: Element truthiness is len(children)
            attrib = isExclusive.attrib
            if 'value' in attrib:
                self.isExclusive = isExclusive.attrib['value']

        means = constraint.findall('cel-ipre:Means', self.namespace)
        m = []
        for i in means:
            attrib = i.attrib
            if 'tec' in attrib:
                m.append(i.attrib['tec'])
        self.means = m

        spatialLocation = constraint.find(
            'cel-ipre:spatialLocation', self.namespace)
        if spatialLocation is not None:  # DMAF: Element truthiness is len(children)
            location = SpatialLocation(
                **{'data': ET.tostring(spatialLocation), 'namespace': self.namespace})
            location.parse()
            self.spatialLocation = location.places
        self.namespace = None
        self.data = None
